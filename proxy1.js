"use strict";

//import { pipeline } from 'stream';
import http from "http";
import https from "https";
import sharp from "sharp";
import pick from "./pick.js";
import UserAgent from 'user-agents';

const DEFAULT_QUALITY = 40;
const MIN_COMPRESS_LENGTH = 1024;
const MIN_TRANSPARENT_COMPRESS_LENGTH = MIN_COMPRESS_LENGTH * 100;
sharp.cache(false);
sharp.simd(true);

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
function copyHeaders(source, target) {
  for (const [key, value] of Object.entries(source.headers)) {
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
function compress(req, res, input) {
  const format = req.params.webp ? "webp" : "jpeg";
  const sharpInstance = sharp({
    failOn: "none",
    limitInputPixels: false,
  });

  // Error handling for the input stream
  input.on("error", () => redirect(req, res));

  // Write chunks to the sharp instance
  input.on("data", (chunk) => sharpInstance.write(chunk));

  // Process the image after the input stream ends
  input.on("end", () => {
    sharpInstance.end();

    // Get metadata and apply transformations
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
  });
}

// Helper to set up response headers
function setupResponseHeaders(sharpInstance, res, format, originSize) {
  sharpInstance.on("info", (info) => {
    res.setHeader("Content-Type", `image/${format}`);
    res.setHeader("Content-Length", info.size);
    res.setHeader("X-Original-Size", originSize);
    res.setHeader("X-Bytes-Saved", originSize - info.size);
    res.statusCode = 200;
  });
}

// Helper to handle streaming data to the response
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








// 
function hhproxy(req, res) {
  const url = req.query.url;
  if (!url) {
    res.statusCode = 400;
    return res.end("Missing 'url' parameter");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(decodeURIComponent(url));
  } catch (err) {
    res.statusCode = 400;
    return res.end("Invalid URL");
  }

  req.params = {
    url: parsedUrl.href,
    webp: !req.query.jpeg,
    grayscale: req.query.bw != 0,
    quality: Math.min(Math.max(parseInt(req.query.l, 10) || DEFAULT_QUALITY, 1), 100)
  };

  const options = {
    headers: {
      ...pick(req.headers, ["cookie", "dnt", "referer", "range"]),
      "User-Agent": USER_AGENT,
      "X-Forwarded-For": req.headers["x-forwarded-for"] || req.ip,
      Via: "1.1 bandwidth-hero"
    },
    maxRedirects: 4
  };

  const requestModule = parsedUrl.protocol === 'https:' ? https : http;

  try {
    const originReq = requestModule.request(parsedUrl, options, originRes => {
      _onRequestResponse(originRes, req, res);
    });

    originReq.on('error', err => {
      _onRequestError(req, res, err);
    });

    originReq.end();
  } catch (err) {
    _onRequestError(req, res, err);
  }
}

function _onRequestError(req, res, err) {
  if (err.code === "ERR_INVALID_URL") {
    res.statusCode = 400;
    return res.end("Invalid URL");
  }

  redirect(req, res);
  console.error(err);
}

function _onRequestResponse(originRes, req, res) {
  if (originRes.statusCode >= 400) {
    return redirect(req, res);
  }

  if (originRes.statusCode >= 300 && originRes.headers.location) {
    req.params.url = originRes.headers.location;
    return redirect(req, res); // Follow the redirect manually
  }

  copyHeaders(originRes, res);

  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");

  req.params.originType = originRes.headers["content-type"] || "";
  req.params.originSize = parseInt(originRes.headers["content-length"] || "0", 10);

  if (shouldCompress(req)) {
    compress(req, res, originRes);
  } else {
    res.setHeader("X-Proxy-Bypass", 1);

    ["accept-ranges", "content-type", "content-length", "content-range"].forEach(header => {
      if (originRes.headers[header]) {
        res.setHeader(header, originRes.headers[header]);
      }
    });

    originRes.pipe(res);
  }
}


export default hhproxy;
