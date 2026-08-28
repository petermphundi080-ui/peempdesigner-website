const https = require("https");
const crypto = require("crypto");

// Cloudinary credentials, set as Render environment variables:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Images are uploaded into this Cloudinary folder, just to keep things
// organized on the Cloudinary side.
const UPLOAD_FOLDER = "peempdesigner/uploads";

// Only allow safe, common image formats. SVG is deliberately excluded --
// SVG files can contain embedded <script> tags and are a stored-XSS risk
// if ever opened directly or embedded unsanitized.
const ALLOWED_MIME_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp"
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

// Cloudinary's signed-upload scheme: take every param except file/api_key/
// signature/resource_type, sort by key, join as "key=value&key=value",
// append the api_secret, then SHA1 hash the whole string. Cloudinary
// recomputes this on their end and rejects the upload if it doesn't match,
// which is what proves the request came from our server and not someone
// else with just the cloud name.
function buildSignature(params, apiSecret) {
    const sortedKeys = Object.keys(params).sort();
    const toSign = sortedKeys
        .map(key => `${key}=${params[key]}`)
        .join("&");

    return crypto
        .createHash("sha1")
        .update(toSign + apiSecret)
        .digest("hex");
}

// Accepts a data URL like "data:image/png;base64,AAAA..." and uploads it
// to Cloudinary. Returns a promise that resolves to the permanent,
// publicly accessible HTTPS URL of the uploaded image (e.g.
// "https://res.cloudinary.com/your-cloud/image/upload/v1234/peempdesigner/uploads/abc123.png").
//
// Unlike the old local-disk version, this URL survives Render restarts,
// redeploys, and idle spin-downs, since the image is no longer stored on
// the app server's filesystem at all.
function saveBase64Image(dataUrl) {
    return new Promise((resolve, reject) => {
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
            reject(new Error("Invalid image data."));
            return;
        }

        const match = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);
        if (!match) {
            reject(new Error("Invalid image data format."));
            return;
        }

        const mimeType = match[1];
        const base64Data = match[2];
        const extension = ALLOWED_MIME_TYPES[mimeType];

        if (!extension) {
            reject(new Error("Unsupported image type. Please use PNG, JPG, GIF, or WEBP."));
            return;
        }

        // Base64 encoding inflates size by roughly 4/3, so this is an
        // approximation, but it's accurate enough to reject obviously
        // oversized uploads before spending time on the network request.
        const approxBytes = Math.floor(base64Data.length * 0.75);

        if (approxBytes === 0) {
            reject(new Error("Image data is empty."));
            return;
        }
        if (approxBytes > MAX_IMAGE_BYTES) {
            reject(new Error("Image is too large. Please use a file under 5MB."));
            return;
        }

        if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
            reject(new Error(
                "Image storage is not configured. Please set CLOUDINARY_CLOUD_NAME, " +
                "CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in Render."
            ));
            return;
        }

        const timestamp = Math.floor(Date.now() / 1000);

        const signature = buildSignature(
            { folder: UPLOAD_FOLDER, timestamp },
            API_SECRET
        );

        const params = new URLSearchParams();
        params.append("file", dataUrl);
        params.append("api_key", API_KEY);
        params.append("timestamp", String(timestamp));
        params.append("folder", UPLOAD_FOLDER);
        params.append("signature", signature);

        const payload = params.toString();

        const options = {
            hostname: "api.cloudinary.com",
            port: 443,
            path: `/v1_1/${CLOUD_NAME}/image/upload`,
            method: "POST",

            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, res => {
            let responseBody = "";

            res.on("data", chunk => {
                responseBody += chunk;
            });

            res.on("end", () => {
                let parsed;

                try {
                    parsed = responseBody ? JSON.parse(responseBody) : {};
                } catch {
                    parsed = {};
                }

                if (
                    res.statusCode >= 200 &&
                    res.statusCode < 300 &&
                    parsed.secure_url
                ) {
                    resolve(parsed.secure_url);
                    return;
                }

                const errorMessage =
                    (parsed.error && parsed.error.message) ||
                    `Cloudinary upload failed (HTTP ${res.statusCode}).`;

                reject(new Error(errorMessage));
            });
        });

        req.setTimeout(20000, () => {
            req.destroy(new Error("Image upload timed out."));
        });

        req.on("error", error => {
            reject(error);
        });

        req.write(payload);
        req.end();
    });
}

// Validate a pasted URL is at least a plausible absolute URL before storing
// it as a field value. This is not a guarantee the URL is safe or reachable,
// just a basic sanity check to catch obvious mistakes. Kept permissive for
// http(s) URLs since Cloudinary URLs, old local "/images/..." paths from
// before this migration, and any other pasted image URL should all still
// be accepted here.
function isValidImageUrl(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    return /^https?:\/\/.+/i.test(trimmed) || /^\/images\/.+/i.test(trimmed);
}

module.exports = {
    saveBase64Image,
    isValidImageUrl,
    MAX_IMAGE_BYTES
};