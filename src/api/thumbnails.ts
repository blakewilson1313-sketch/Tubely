import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { mediaTypeToExt } from "./assets";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }
  const MAX_UPLOAD_SIZE = 10 << 20;
  if(file.size > MAX_UPLOAD_SIZE){
    throw new BadRequestError("Thumbnail File Too Large");
  }
  const fileType = file.type;
  if(!(fileType === "image/jpeg" || fileType === "image/png")){
    throw new BadRequestError("Invalid Upload Format");
  }
  const randomByteBuffer = randomBytes(32);
  const randomThumbnailID = randomByteBuffer.toString("base64url")

  const fileExtension = mediaTypeToExt(fileType);
  const fileDataArray = await file.arrayBuffer();
  const filePath = `${cfg.assetsRoot}/${randomThumbnailID}${fileExtension}`; 
  const dataURL = `http://localhost:${cfg.port}/assets/${randomThumbnailID}${fileExtension}`;
  const videoMetaData = getVideo(cfg.db, videoId);
  if(!videoMetaData){
    throw new NotFoundError("Video Not Found");
  }
  if(userID !== videoMetaData?.userID){
    throw new UserForbiddenError("Not Video Owner");
  }
  await Bun.write(filePath, fileDataArray);
  videoMetaData.thumbnailURL = dataURL;
  
  updateVideo(cfg.db, videoMetaData);

  return respondWithJSON(200, videoMetaData);
}
