"use strict";
import got from "got";
import sharp from "sharp";
import pick from "./pick.js";
import UserAgent from "user-agents";

const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;

// Helper: Should compress
function shouldCompress(req) {
  const { originType, originSize, webp } = req.params;

  if (!originType.startsWith("image")) return false;
  if (originSize === 0) return false;
  if (req.headers.range) return false;
  if (webp && originSize < MIN_COMPRESS_LENGTH) return false;
  if (
    !webp &&
    (originType.endsWith("png") || originType.endsWith("gif")) &&
    originSize < MIN_TRANSPARENT_COMPRESS_LENGTH
  ) {
    return false;
  }

  return true;
}

// Helper: Copy headers
function copyHeaders(sourceHeaders, target) {
  for (const [key, value] of Object.entries(sourceHeaders)) {
    try {
      target.setHeader(key, value);
    } catch (e) {
      console.log(e.message);
    }
  }
}

// Helper: Redirect
function redirect(req, res) {
  if (res.headersSent) return;

  res.setHeader("content-length", 0);
  res.removeHeader("cache-control");
  res.removeHeader("expires");
  res.removeHeader("date");
  res.removeHeader("etag");
  res.setHeader("location", encodeURI(req.params.url));
  res.statusCode = 302;
  res.end();
}

// Helper: Compress
const sharpStream = () => sharp({ animated: false, unlimited: true });
function compress(req, res, input) {
  const format = req.params.webp ? "webp" : "jpeg";
  const sharpInstance = sharpStream();

  input.on("error", () => redirect(req, res));

  input.pipe(sharpInstance).on("error", () => redirect(req, res));

  sharpInstance
    .metadata()
    .then((metadata) => {
      if (metadata.height > 16383) {
        sharpInstance.resize({
          height: 16383,
          withoutEnlargement: true,
        });
      }

      sharpInstance
        .grayscale(req.params.grayscale)
        .toFormat(format, {
          quality: req.params.quality,
          effort: 0,
        });

      setupResponseHeaders(sharpInstance, res, format, req.params.originSize);
      streamToResponse(sharpInstance, res);
    })
    .catch(() => redirect(req, res));

  function setupResponseHeaders(sharpInstance, res, format, originSize) {
    sharpInstance.on("info", (info) => {
      res.setHeader("Content-Type", `image/${format}`);
      res.setHeader("Content-Length", info.size);
      res.setHeader("X-Original-Size", originSize);
      res.setHeader("X-Bytes-Saved", originSize - info.size);
      res.statusCode = 200;
    });
  }

  function streamToResponse(sharpInstance, res) {
    sharpInstance.on("data", (chunk) => {
      if (!res.write(chunk)) {
        sharpInstance.pause();
        res.once("drain", () => sharpInstance.resume());
      }
    });

    sharpInstance.on("end", () => res.end());
    sharpInstance.on("error", () => redirect(req, res));
  }
}

// Main proxy handler
async function hhproxy(req, res) {
  const url = req.query.url;
  if (!url) {
    return res.end("bandwidth-hero-proxy");
  }

  req.params = {
    url: decodeURIComponent(url),
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: parseInt(req.query.l, 10) || DEFAULT_QUALITY,
  };

  const userAgent = new UserAgent();
  const options = {
    headers: {
      ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
      "User-Agent": userAgent.toString(),
      "X-Forwarded-For": req.headers["x-forwarded-for"] || req.ip,
      Via: "1.1 bandwidth-hero",
    },
    maxRedirects: 2,
    throwHttpErrors: false
  };

  try {
    let origin = await got.stream(req.params.url, options);

    origin.on('response', (originResponse) => {
      
    if (originResponse.statusCode >= 400)
    return redirect(req, res);

  // handle redirects
  if (originResponse.statusCode >= 300 && originResponse.headers.location)
    return redirect(req, res);

      // Copy headers to response
      copyHeaders(originResponse, res);
      res.setHeader("content-encoding", "identity");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
      req.params.originType = originResponse.headers["content-type"] || "";
      req.params.originSize = originResponse.headers["content-length"] || "0";

      // Handle streaming response
      origin.on('error', () => req.socket.destroy());

      if (shouldCompress(req)) {
        // Compress and pipe response if required
        return compress(req, res, origin);
      } else {
        // Bypass compression
        res.setHeader("x-proxy-bypass", 1);

        // Set specific headers
        for (const headerName of ["accept-ranges", "content-type", "content-length", "content-range"]) {
          if (headerName in originResponse.headers) res.setHeader(headerName, originResponse.headers[headerName]);
        }

        return origin.pipe(res);
      }
    });
  } catch (err) {
    // Handle error directly
    if (err.code === "ERR_INVALID_URL") {
      return res.status(400).send("Invalid URL");
    }

    // Redirect on other errors
    redirect(req, res);
    console.error(err);
  }
}
export default hhproxy;
