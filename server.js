const http = require("http");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const cookie = require("cookie");
const crypto = require("crypto");

require("dotenv").config();

const host = "0.0.0.0";
const port = Number(process.env.PORT) || 3000;
const publicDirectory = __dirname;
const maxBodySize = 10000;
const contactRateLimit = 5;
const contactRateWindowMs = 15 * 60 * 1000;
const requestCounts = new Map();

// Active admin sessions stored in memory
const activeSessions = new Set();

const publicFiles = new Set([
    "about.html",
    "all-work.html",
    "contact.html",
    "index.html",
    "portfolio.html",
    "project.html",
    "admin.html" // Added Admin Page
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

function parseCookies(request) {
    return cookie.parse(request.headers.cookie || "");
}

function isAuthenticated(request) {
    const cookies = parseCookies(request);
    return cookies.admin_session && activeSessions.has(cookies.admin_session);
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
        console.error("Mailer Error: Missing EMAIL_USER or EMAIL_PASS.");
        return null;
    }

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
            sendJson(response, 400, { error: "Please complete all required fields." });
            return;
        }

        const mailer = createMailer();
        if (!mailer || !process.env.EMAIL_TO) {
            sendJson(response, 503, { error: "Email service not configured." });
            return;
        }

        const info = await mailer.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_TO.trim(),
            replyTo: email,
            subject: `${project} inquiry from ${name}`,
            text: `Name: ${name}\nEmail: ${email}\nProject: ${project}\n\nMessage:\n${message}`
        });

        console.log("Email sent successfully! ID:", info.messageId);
        sendJson(response, 200, { success: true, message: "Your message was sent successfully." });

    } catch (error) {
        console.error("Contact error:", error);
        sendJson(response, 500, { error: error.message || "Unable to send message." });
    }
}

const server = http.createServer(async (request, response) => {
    response.setTimeout(15000, () => response.destroy());

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

    // Rate Limiting for Contact Form
    if (requestPath === "/api/contact" && request.method === "POST") {
        const clientIp = request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown";
        const now = Date.now();
        const recentRequests = (requestCounts.get(clientIp) || []).filter(
            timestamp => now - timestamp < contactRateWindowMs
        );

        if (recentRequests.length >= contactRateLimit) {
            sendJson(response, 429, { error: "Too many requests." });
            return;
        }
        recentRequests.push(now);
        requestCounts.set(clientIp, recentRequests);
    }

    // --- ADMIN API ROUTES ---
    if (request.method === "POST" && requestPath === "/api/admin/login") {
        try {
            const body = JSON.parse(await readRequestBody(request));
            if (body.username === process.env.ADMIN_USER && body.password === process.env.ADMIN_PASS) {
                const sessionId = crypto.randomBytes(32).toString("hex");
                activeSessions.add(sessionId);

                const cookieHeader = cookie.serialize("admin_session", sessionId, {
                    httpOnly: true,
                    path: "/",
                    sameSite: "strict",
                    maxAge: 60 * 60 * 24 // 24 hours
                });

                sendJson(response, 200, { success: true }, { "Set-Cookie": cookieHeader });
            } else {
                sendJson(response, 401, { error: "Invalid admin credentials." });
            }
        } catch (e) {
            sendJson(response, 400, { error: "Invalid request payload." });
        }
        return;
    }

    if (request.method === "POST" && requestPath === "/api/admin/logout") {
        const cookies = parseCookies(request);
        if (cookies.admin_session) {
            activeSessions.delete(cookies.admin_session);
        }
        const cookieHeader = cookie.serialize("admin_session", "", {
            httpOnly: true,
            path: "/",
            maxAge: 0
        });
        sendJson(response, 200, { success: true }, { "Set-Cookie": cookieHeader });
        return;
    }

    if (request.method === "GET" && requestPath === "/api/admin/dashboard") {
        if (!isAuthenticated(request)) {
            sendJson(response, 401, { error: "Unauthorized access." });
            return;
        }
        sendJson(response, 200, { message: "Authenticated successfully." });
        return;
    }

    // --- STANDARD API ROUTES ---
    if (request.method === "POST" && requestPath === "/api/contact") {
        await handleContact(request, response);
        return;
    }

    if (requestPath === "/api/health" || requestPath === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
    }

    // Static File Serving
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
    serveFile(response, filePath);
});

server.listen(port, host, () => {
    console.log(`PEEMPDESIGNER server running on port ${port}`);
});
