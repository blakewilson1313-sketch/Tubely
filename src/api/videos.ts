import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError, NotFoundError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { type ApiConfig } from "../config";
import { S3Client, type BunRequest } from "bun";
import { rm } from "fs/promises";
import { stdout } from "process";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
    if (!videoId) {
      throw new BadRequestError("Invalid or no video ID");
    }
  
    const token = getBearerToken(req.headers);
    const userID = validateJWT(token, cfg.jwtSecret);

    const MAX_UPLOAD_SIZE = 1 << 30;       
    const videoMetaData = getVideo(cfg.db, videoId);
    
    if(!videoMetaData){
      throw new NotFoundError("Video Not Found");
    }
    if(userID !== videoMetaData?.userID){
      throw new UserForbiddenError("Not Video Owner");
    }
    const formData = await req.formData();
    const file = formData.get("video");
    if (!(file instanceof File)) {
      throw new BadRequestError("Video file missing");
    }
    console.log("uploading video", videoId, "by user", userID);

    if(file.size > MAX_UPLOAD_SIZE){
      throw new BadRequestError("Video Too Large");
    }
    const fileType = file.type;
    if(!(fileType === "video/mp4")){
      throw new BadRequestError("Invalid Upload Format");
    }
    const tempFilePath = `/tmp/${videoId}.mp4`
    await Bun.write(tempFilePath, file);
    const processedPath = await processVideoForFastStart(tempFilePath);
    const processedVideo = Bun.file(processedPath);
    
    
    const aspectRatioLabel = await getAspectRatioFromPath(tempFilePath)
    const videoURL = `${cfg.s3CfDistribution}/${aspectRatioLabel}/${videoId}.mp4`;
    videoMetaData.videoURL = videoURL;
  
    const updatedFile = cfg.s3Client.file(`${aspectRatioLabel}/${videoId}.mp4`, { bucket: cfg.s3Bucket });
    await updatedFile.write(processedVideo, {type: fileType});
    updateVideo(cfg.db, videoMetaData);

    await rm(tempFilePath, {force: true});
    return respondWithJSON(200, videoMetaData);
}

export async function getAspectRatioFromPath(filePath: string): Promise<string> {
  const proc = Bun.spawn(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",`${filePath}`],{
  stdout: "pipe",
  stderr: "pipe",
});
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if(exitCode !== 0){
    throw new Error(`FFProbe Error: ${exitCode}`);
  }
  
  type Aspect = {
    width: number,
    height: number,
  }
  const aspectJSON = JSON.parse(stdoutText);
  const aspectRatio: Aspect = aspectJSON.streams[0];
  switch(true){
    case (aspectRatio.width === Math.floor(16 * (aspectRatio.height / 9))):
      return "landscape";
    case (aspectRatio.height === Math.floor(16 * (aspectRatio.width / 9))):
      return "portrait";
    default:
      return "other";
  }
}

async function processVideoForFastStart(inputFilePath: string){
  const outputFile = inputFilePath.split(".mp4");
  const outputFilePath = `${outputFile[0]}.processed.mp4`;
  
  const proc = Bun.spawn(["ffmpeg","-y","-i",`${inputFilePath}`,"-movflags","faststart","-map_metadata","0","-codec","copy","-f","mp4",`${outputFilePath}`],{
  stdout: "pipe",
  stderr: "pipe",
  });
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if(exitCode !== 0){
    throw new Error(`FFMPEG Error: ${exitCode}`);
  }
  return outputFilePath;
}
