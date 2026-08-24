const http = require("http");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

require("dotenv").config();

// Listen on 0.0.0.0 so Render's internal routing can reach your app
const host = "0.0.0.0";
const port = Number(process.env.PORT) || 3000;
const publicDirectory = __dirname;
const maxBodySize = 10000;
const contactRateLimit = 5;
const contactRateWindowMs = 15 * 60 * 1000;
const requestCounts = new Map();

const publicFiles = new Set([
    "about.html",
    "all-work.html",
    "contact.html",
    "index.html",
    "portfolio.html",
    "project.html"
]);

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp"
};

function setSecurityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.figma.com https://*.figma.com; form-action 'self'; frame-ancestors 'none'"
    );
    // Allow frontend to communicate with this backend
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getRequestProtocol(request) {
    if (process.env.TRUST_PROXY === "true" && request.headers["x-forwarded-proto"]) {
        return request.headers["x-forwarded-proto"].split(",")[0].trim();
    }
    return "http";
}

function sendJson(response, statusCode, payload, headers = {}) {
    setSecurityHeaders(response);
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        ...headers
    });
    response.end(JSON.stringify(payload));
}

function serveFile(response, filePath) {
    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            sendJson(response, 404, { error: "Not found" });
            return;
        }

        const extension = path.extname(filePath).toLowerCase();

        setSecurityHeaders(response);
        response.writeHead(200, {
            "Content-Type": mimeTypes[extension] || "application/octet-stream",
            "Cache-Control": "no-cache"
        });

        fs.createReadStream(filePath).pipe(response);
    });
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";

        request.on("data", chunk => {
            body += chunk;
            if (body.length > maxBodySize) {
                reject(new Error("Request body too large"));
                request.resume();
            }
        });

        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function createMailer() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error("Mailer Error: EMAIL_USER or EMAIL_PASS environment variable is missing.");
        return null;
    }

    // Switched to built-in Gmail service to bypass port 587 cloud firewall blocks
    return nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_USER.trim(),
            pass: process.env.EMAIL_PASS.trim()
        }
    });
}

async function handleContact(request, response) {
    try {
        if (request.headers["content-type"] !== "application/json") {
            sendJson(response, 415, { error: "JSON requests are required." });
            return;
        }

        const body = JSON.parse(await readRequestBody(request));

        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const project = typeof body.project === "string" ? body.project.trim() : "";
        const message = typeof body.message === "string" ? body.message.trim() : "";
        const honeypot = typeof body.website === "string" ? body.website.trim() : "";

        if (honeypot || !name || !email || !project || !message) {
            sendJson(response, 400, {
                error: "Please complete all required fields."
            });
            return;
        }

        if (
            name.length > 80 ||
            email.length > 120 ||
            project.length > 80 ||
            message.length > 2000
        ) {
            sendJson(response, 400, {
                error: "One or more fields are too long."
            });
            return;
        }

        const allowedProjects = new Set([
            "Brand Identity",
            "Logo Design",
            "Poster Design",
            "Social Media Design",
            "Website Design",
            "Other"
        ]);

        if (!allowedProjects.has(project)) {
            sendJson(response, 400, { error: "Please select a valid project type." });
            return;
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(email)) {
            sendJson(response, 400, {
                error: "Please enter a valid email address."
            });
            return;
        }

        const mailer = createMailer();
        if (!mailer || !process.env.EMAIL_TO) {
            console.error("Mailer Error: Configuration incomplete. Check environment variables.");
            sendJson(response, 503, {
                error: "Email service configuration is missing on the server."
            });
            return;
        }

        const info = await mailer.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_TO.trim(),
            replyTo: email,
            subject: `${project} inquiry from ${name}`,
            text: `Name: ${name}\nEmail: ${email}\nProject: ${project}\n\nMessage:\n${message}`
        });

        console.log("Email sent successfully! Message ID:", info.messageId);

        sendJson(response, 200, {
            success: true,
            message: "Your message was sent successfully."
        });

    } catch (error) {
        if (error.message === "Request body too large") {
            sendJson(response, 413, { error: "Request body too large." });
            return;
        }

        if (error instanceof SyntaxError) {
            sendJson(response, 400, { error: "Invalid request." });
            return;
        }

        // Output full detailed error stack to Render logs for easy debugging
        console.error("Contact form processing error:", error);
        sendJson(response, 500, { error: error.message || "Unable to send the message." });
    }
}

const server = http.createServer(async (request, response) => {
    response.setTimeout(15000, () => response.destroy());

    // Handle preflight CORS requests
    if (request.method === "OPTIONS") {
        setSecurityHeaders(response);
        response.writeHead(204);
        response.end();
        return;
    }

    const protocol = getRequestProtocol(request);
    const baseUrl = `${protocol}://${request.headers.host || `0.0.0.0:${port}`}`;
    const requestPath = new URL(request.url, baseUrl).pathname;

    setSecurityHeaders(response);

    // Rate limiting for contact route
    if (requestPath === "/api/contact" && request.method === "POST") {
        const clientIp = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown";
        const now = Date.now();
        const recentRequests = (requestCounts.get(clientIp) || []).filter(
            timestamp => now - timestamp < contactRateWindowMs
        );

        if (recentRequests.length >= contactRateLimit) {
            sendJson(response, 429, {
                error: "Too many requests. Please try again later."
            }, {
                "Retry-After": String(Math.ceil(contactRateWindowMs / 1000))
            });
            return;
        }

        recentRequests.push(now);
        requestCounts.set(clientIp, recentRequests);
    }

    // Contact API Route
    if (request.method === "POST" && requestPath === "/api/contact") {
        await handleContact(request, response);
        return;
    }

    // Health check endpoint for Render
    if (requestPath === "/api/health" || requestPath === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
    }

    // Static file serving fallback
    if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    const requestedFile = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
    const isImageAsset = requestedFile.startsWith("images/");

    if (!publicFiles.has(requestedFile) && !isImageAsset) {
        sendJson(response, 404, { error: "Not found" });
        return;
    }

    const filePath = path.resolve(publicDirectory, requestedFile);

    if (filePath !== publicDirectory && !filePath.startsWith(publicDirectory + path.sep)) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
    }

    serveFile(response, filePath);
});

server.listen(port, host, () => {
    console.log(`PEEMPDESIGNER server running on port ${port}`);
});
