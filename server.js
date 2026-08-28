const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cookie = require("cookie");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const usersStore = require("./lib/usersstore");
const contentStore = require("./lib/contentstore");
const pageContentStore = require("./lib/pagecontentstore");
const mediaStore = require("./lib/mediastore");
const portfolioStore = require("./lib/portfoliostore");

require("dotenv").config();

const host = "0.0.0.0";
const port = Number(process.env.PORT) || 3000;
const publicDirectory = __dirname;

const maxBodySize = 10000;

const contactRateLimit = 5;
const contactRateWindowMs = 15 * 60 * 1000;
const requestCounts = new Map();

// Active admin sessions stored in memory
const activeSessions = new Map();
const SESSION_DURATION_MS = 60 * 60 * 24 * 1000;

// Admin login rate limiter
const adminLoginAttempts = new Map();
const adminLoginLimit = 5;
const adminLoginWindowMs = 15 * 60 * 1000;

const publicFiles = new Set([
    "about.html",
    "all-work.html",
    "contact.html",
    "index.html",
    "portfolio.html",
    "project.html",
    "admin.html"
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


/* =========================================================
   SECURITY HEADERS
========================================================= */

function setSecurityHeaders(response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
        "Referrer-Policy",
        "strict-origin-when-cross-origin"
    );

    response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; " +
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
        "font-src https://fonts.gstatic.com; " +
        "script-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://www.figma.com https://*.figma.com; " +
        "form-action 'self'; " +
        "frame-ancestors 'none'"
    );

    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
        "Access-Control-Allow-Methods",
        "POST, GET, PUT, DELETE, OPTIONS"
    );
    response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );
}


/* =========================================================
   HELPERS
========================================================= */

function getRequestProtocol(request) {
    if (
        process.env.TRUST_PROXY === "true" &&
        request.headers["x-forwarded-proto"]
    ) {
        return request.headers["x-forwarded-proto"]
            .split(",")[0]
            .trim();
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
    const sessionId = cookies.admin_session;

    if (!sessionId || !activeSessions.has(sessionId)) {
        return false;
    }

    const expiry = activeSessions.get(sessionId);

    if (Date.now() > expiry) {
        activeSessions.delete(sessionId);
        return false;
    }

    return true;
}


/* =========================================================
   CLEAN EXPIRED SESSIONS
========================================================= */

setInterval(() => {
    const now = Date.now();

    for (const [id, expiry] of activeSessions) {
        if (now > expiry) {
            activeSessions.delete(id);
        }
    }
}, 60 * 60 * 1000);


/* =========================================================
   ADMIN LOGIN RATE LIMIT
========================================================= */

function isAdminLoginRateLimited(clientIp) {
    const now = Date.now();

    const attempts = (
        adminLoginAttempts.get(clientIp) || []
    ).filter(
        t => now - t < adminLoginWindowMs
    );

    attempts.push(now);

    adminLoginAttempts.set(clientIp, attempts);

    return attempts.length > adminLoginLimit;
}


/* =========================================================
   STATIC FILES
========================================================= */

function serveFile(response, filePath) {
    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            sendJson(response, 404, {
                error: "Not found"
            });
            return;
        }

        const extension = path.extname(filePath).toLowerCase();

        setSecurityHeaders(response);

        response.writeHead(200, {
            "Content-Type":
                mimeTypes[extension] ||
                "application/octet-stream",
            "Cache-Control": "no-cache"
        });

        fs.createReadStream(filePath).pipe(response);
    });
}


/* =========================================================
   READ REQUEST BODY
========================================================= */

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";

        request.on("data", chunk => {
            body += chunk;

            if (body.length > maxBodySize) {
                reject(
                    new Error("Request body too large")
                );

                request.resume();
            }
        });

        request.on("end", () => {
            resolve(body);
        });

        request.on("error", reject);
    });
}


/* =========================================================
   IMAGE UPLOAD BODY
========================================================= */

const maxUploadBodySize = 7 * 1024 * 1024;

function readUploadBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalLength = 0;

        request.on("data", chunk => {
            totalLength += chunk.length;

            if (totalLength > maxUploadBodySize) {
                reject(
                    new Error("Upload too large.")
                );

                request.resume();
                return;
            }

            chunks.push(chunk);
        });

        request.on("end", () => {
            resolve(
                Buffer.concat(chunks).toString("utf8")
            );
        });

        request.on("error", reject);
    });
}


/* =========================================================
   RESEND EMAIL
========================================================= */

/*
   This uses the Resend API directly.

   Required Render environment variables:

   RESEND_API_KEY
   EMAIL_TO

   Optional:

   RESEND_FROM_EMAIL

   Example:

   RESEND_API_KEY=re_xxxxxxxxx
   EMAIL_TO=your@email.com
   RESEND_FROM_EMAIL=onboarding@resend.dev

   If you have verified your own domain with Resend,
   use an email address from that domain for
   RESEND_FROM_EMAIL.
*/

function sendEmailWithResend({
    from,
    to,
    replyTo,
    subject,
    text
}) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.RESEND_API_KEY;

        if (!apiKey) {
            reject(
                new Error(
                    "RESEND_API_KEY is not configured."
                )
            );

            return;
        }

        const payload = JSON.stringify({
            from,
            to: [to],
            reply_to: replyTo,
            subject,
            text
        });

        const options = {
            hostname: "api.resend.com",
            port: 443,
            path: "/emails",
            method: "POST",

            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
            }
        };

        const req = https.request(
            options,
            res => {
                let responseBody = "";

                res.on("data", chunk => {
                    responseBody += chunk;
                });

                res.on("end", () => {
                    let parsed;

                    try {
                        parsed = responseBody
                            ? JSON.parse(responseBody)
                            : {};
                    } catch {
                        parsed = {};
                    }

                    if (
                        res.statusCode >= 200 &&
                        res.statusCode < 300
                    ) {
                        resolve(parsed);
                        return;
                    }

                    const errorMessage =
                        parsed.message ||
                        parsed.error ||
                        `Resend returned HTTP ${res.statusCode}.`;

                    reject(
                        new Error(errorMessage)
                    );
                });
            }
        );

        req.setTimeout(15000, () => {
            req.destroy(
                new Error(
                    "Resend request timed out."
                )
            );
        });

        req.on("error", error => {
            reject(error);
        });

        req.write(payload);
        req.end();
    });
}


/* =========================================================
   CONTACT FORM
========================================================= */

async function handleContact(request, response) {
    try {
        const contentType =
            request.headers["content-type"] || "";

        if (
            !contentType
                .toLowerCase()
                .startsWith("application/json")
        ) {
            sendJson(response, 415, {
                error: "JSON requests are required."
            });

            return;
        }

        const body = JSON.parse(
            await readRequestBody(request)
        );

        const name =
            typeof body.name === "string"
                ? body.name.trim()
                : "";

        const email =
            typeof body.email === "string"
                ? body.email.trim()
                : "";

        const project =
            typeof body.project === "string"
                ? body.project.trim()
                : "";

        const message =
            typeof body.message === "string"
                ? body.message.trim()
                : "";

        const honeypot =
            typeof body.website === "string"
                ? body.website.trim()
                : "";

        if (
            honeypot ||
            !name ||
            !email ||
            !project ||
            !message
        ) {
            sendJson(response, 400, {
                error:
                    "Please complete all required fields."
            });

            return;
        }

        /*
           Check Resend configuration.
        */

        if (!process.env.RESEND_API_KEY) {
            console.error(
                "RESEND_API_KEY is missing."
            );

            sendJson(response, 503, {
                error:
                    "Email service is not configured. Please add RESEND_API_KEY in Render."
            });

            return;
        }

        if (!process.env.EMAIL_TO) {
            console.error(
                "EMAIL_TO is missing."
            );

            sendJson(response, 503, {
                error:
                    "EMAIL_TO is not configured."
            });

            return;
        }

        /*
           Resend's testing sender.
           If you have a verified domain, replace this
           through the Render environment variable.
        */

        const fromEmail =
            (
                process.env.RESEND_FROM_EMAIL ||
                "onboarding@resend.dev"
            ).trim();

        const toEmail =
            process.env.EMAIL_TO.trim();

        const subject =
            `${project} inquiry from ${name}`;

        const emailText =
            `Name: ${name}\n` +
            `Email: ${email}\n` +
            `Project: ${project}\n\n` +
            `Message:\n${message}`;

        const info =
            await sendEmailWithResend({
                from: fromEmail,
                to: toEmail,
                replyTo: email,
                subject,
                text: emailText
            });

        console.log(
            "Email sent successfully!",
            info
        );

        sendJson(response, 200, {
            success: true,
            message:
                "Your message was sent successfully."
        });

    } catch (error) {
        console.error(
            "Contact error:",
            error
        );

        sendJson(response, 500, {
            error:
                error.message ||
                "Unable to send message."
        });
    }
}


/* =========================================================
   USERS
========================================================= */

function handleGetUsers(request, response) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    const users =
        usersStore.getAllUsers();

    sendJson(response, 200, {
        users
    });
}


async function handleCreateUser(request, response) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const newUser =
            usersStore.createUser(body);

        sendJson(response, 201, {
            success: true,
            user: newUser
        });

    } catch (err) {
        sendJson(response, 400, {
            error:
                err.message ||
                "Unable to create user."
        });
    }
}


async function handleUpdateUser(
    request,
    response,
    userId
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const updated =
            usersStore.updateUser(
                userId,
                body
            );

        sendJson(response, 200, {
            success: true,
            user: updated
        });

    } catch (err) {
        const status =
            err.message === "User not found."
                ? 404
                : 400;

        sendJson(response, status, {
            error:
                err.message ||
                "Unable to update user."
        });
    }
}


function handleDeleteUser(
    request,
    response,
    userId
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        usersStore.deleteUser(userId);

        sendJson(response, 200, {
            success: true
        });

    } catch (err) {
        sendJson(response, 404, {
            error:
                err.message ||
                "User not found."
        });
    }
}


/* =========================================================
   CONTENT
========================================================= */

function handleGetContent(request, response) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    const items =
        contentStore.getAllContent();

    sendJson(response, 200, {
        content: items
    });
}


async function handleCreateContent(
    request,
    response
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const newItem =
            contentStore.createContent(body);

        sendJson(response, 201, {
            success: true,
            content: newItem
        });

    } catch (err) {
        sendJson(response, 400, {
            error:
                err.message ||
                "Unable to create content."
        });
    }
}


async function handleUpdateContent(
    request,
    response,
    contentId
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const updated =
            contentStore.updateContent(
                contentId,
                body
            );

        sendJson(response, 200, {
            success: true,
            content: updated
        });

    } catch (err) {
        const status =
            err.message ===
            "Content item not found."
                ? 404
                : 400;

        sendJson(response, status, {
            error:
                err.message ||
                "Unable to update content."
        });
    }
}


function handleDeleteContent(
    request,
    response,
    contentId
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        contentStore.deleteContent(
            contentId
        );

        sendJson(response, 200, {
            success: true
        });

    } catch (err) {
        sendJson(response, 404, {
            error:
                err.message ||
                "Content not found."
        });
    }
}


/* =========================================================
   PAGE CONTENT
========================================================= */

function handleGetPublicPage(
    request,
    response,
    pageName
) {
    try {
        const content =
            pageContentStore.getPageContent(
                pageName
            );

        sendJson(response, 200, {
            content
        });

    } catch (err) {
        sendJson(response, 404, {
            error: "Page not found."
        });
    }
}


function handleGetAdminPage(
    request,
    response,
    pageName
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    const schema =
        pageContentStore.getPageSchema(
            pageName
        );

    if (!schema) {
        sendJson(response, 404, {
            error: "Page not found."
        });

        return;
    }

    const content =
        pageContentStore.getPageContent(
            pageName
        );

    sendJson(response, 200, {
        fields: schema,
        content
    });
}


async function handleUpdatePage(
    request,
    response,
    pageName
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const updated =
            pageContentStore.updatePageContent(
                pageName,
                body
            );

        sendJson(response, 200, {
            success: true,
            content: updated
        });

    } catch (err) {
        sendJson(response, 400, {
            error:
                err.message ||
                "Unable to update page."
        });
    }
}


/* =========================================================
   IMAGE UPLOAD
========================================================= */

async function handleImageUpload(
    request,
    response
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readUploadBody(request)
        );

        const imageData =
            typeof body.image === "string"
                ? body.image
                : "";

        const url =
            mediaStore.saveBase64Image(
                imageData
            );

        sendJson(response, 200, {
            success: true,
            url
        });

    } catch (err) {
        sendJson(response, 400, {
            error:
                err.message ||
                "Unable to upload image."
        });
    }
}


/* =========================================================
   PORTFOLIO PROJECTS
========================================================= */

function handleGetPublicProjects(
    request,
    response
) {
    try {
        const projects =
            portfolioStore.getAllProjects();

        sendJson(response, 200, {
            projects
        });

    } catch (err) {
        console.error(
            "Portfolio error:",
            err
        );

        sendJson(response, 500, {
            error:
                err.message ||
                "Unable to load projects."
        });
    }
}


function handleGetAdminProjects(
    request,
    response
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    const projects =
        portfolioStore.getAllProjects();

    sendJson(response, 200, {
        projects,
        categories:
            portfolioStore.VALID_CATEGORIES
    });
}


async function handleCreateProject(
    request,
    response
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const newProject =
            portfolioStore.createProject(
                body
            );

        sendJson(response, 201, {
            success: true,
            project: newProject
        });

    } catch (err) {
        sendJson(response, 400, {
            error:
                err.message ||
                "Unable to create project."
        });
    }
}


async function handleUpdateProject(
    request,
    response,
    projectId
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        const body = JSON.parse(
            await readRequestBody(request)
        );

        const updated =
            portfolioStore.updateProject(
                projectId,
                body
            );

        sendJson(response, 200, {
            success: true,
            project: updated
        });

    } catch (err) {
        const status =
            err.message ===
            "Project not found."
                ? 404
                : 400;

        sendJson(response, status, {
            error:
                err.message ||
                "Unable to update project."
        });
    }
}


function handleDeleteProject(
    request,
    response,
    projectId
) {
    if (!isAuthenticated(request)) {
        sendJson(response, 401, {
            error: "Unauthorized access."
        });

        return;
    }

    try {
        portfolioStore.deleteProject(
            projectId
        );

        sendJson(response, 200, {
            success: true
        });

    } catch (err) {
        sendJson(response, 404, {
            error:
                err.message ||
                "Project not found."
        });
    }
}


/* =========================================================
   SERVER
========================================================= */

const server = http.createServer(
    async (request, response) => {

        response.setTimeout(
            15000,
            () => response.destroy()
        );

        /* OPTIONS */

        if (request.method === "OPTIONS") {
            setSecurityHeaders(response);
            response.writeHead(204);
            response.end();
            return;
        }


        /* REQUEST URL */

        const protocol =
            getRequestProtocol(request);

        const baseUrl =
            `${protocol}://${request.headers.host ||
            `0.0.0.0:${port}`}`;

        const requestPath =
            new URL(
                request.url,
                baseUrl
            ).pathname;

        setSecurityHeaders(response);


        /* =================================================
           CONTACT RATE LIMIT
        ================================================= */

        if (
            requestPath === "/api/contact" &&
            request.method === "POST"
        ) {
            const clientIp =
                request.headers["x-forwarded-for"] ||
                request.socket.remoteAddress ||
                "unknown";

            const now = Date.now();

            const recentRequests =
                (
                    requestCounts.get(clientIp) ||
                    []
                ).filter(
                    timestamp =>
                        now - timestamp <
                        contactRateWindowMs
                );

            if (
                recentRequests.length >=
                contactRateLimit
            ) {
                sendJson(response, 429, {
                    error:
                        "Too many requests."
                });

                return;
            }

            recentRequests.push(now);

            requestCounts.set(
                clientIp,
                recentRequests
            );
        }


        /* =================================================
           ADMIN LOGIN
        ================================================= */

        if (
            request.method === "POST" &&
            requestPath ===
                "/api/admin/login"
        ) {
            const clientIp =
                request.headers["x-forwarded-for"] ||
                request.socket.remoteAddress ||
                "unknown";

            if (
                isAdminLoginRateLimited(
                    clientIp
                )
            ) {
                sendJson(response, 429, {
                    error:
                        "Too many login attempts. Try again later."
                });

                return;
            }

            try {
                const body = JSON.parse(
                    await readRequestBody(
                        request
                    )
                );

                const username =
                    typeof body.username ===
                    "string"
                        ? body.username
                        : "";

                const password =
                    typeof body.password ===
                    "string"
                        ? body.password
                        : "";

                const usernameMatches =
                    username ===
                    process.env.ADMIN_USER;

                const passwordMatches =
                    usernameMatches
                        ? await bcrypt.compare(
                            password,
                            process.env.ADMIN_PASS_HASH
                        )
                        : false;

                if (
                    usernameMatches &&
                    passwordMatches
                ) {
                    const sessionId =
                        crypto.randomBytes(
                            32
                        ).toString("hex");

                    activeSessions.set(
                        sessionId,
                        Date.now() +
                            SESSION_DURATION_MS
                    );

                    const cookieHeader =
                        cookie.serialize(
                            "admin_session",
                            sessionId,
                            {
                                httpOnly: true,
                                path: "/",
                                sameSite: "strict",
                                secure:
                                    process.env.NODE_ENV ===
                                    "production",
                                maxAge:
                                    60 * 60 * 24
                            }
                        );

                    sendJson(
                        response,
                        200,
                        {
                            success: true
                        },
                        {
                            "Set-Cookie":
                                cookieHeader
                        }
                    );

                } else {
                    sendJson(
                        response,
                        401,
                        {
                            error:
                                "Invalid admin credentials."
                        }
                    );
                }

            } catch (e) {
                sendJson(
                    response,
                    400,
                    {
                        error:
                            "Invalid request payload."
                    }
                );
            }

            return;
        }


        /* =================================================
           ADMIN LOGOUT
        ================================================= */

        if (
            request.method === "POST" &&
            requestPath ===
                "/api/admin/logout"
        ) {
            const cookies =
                parseCookies(request);

            if (cookies.admin_session) {
                activeSessions.delete(
                    cookies.admin_session
                );
            }

            const cookieHeader =
                cookie.serialize(
                    "admin_session",
                    "",
                    {
                        httpOnly: true,
                        path: "/",
                        sameSite: "strict",
                        secure:
                            process.env.NODE_ENV ===
                            "production",
                        maxAge: 0
                    }
                );

            sendJson(
                response,
                200,
                {
                    success: true
                },
                {
                    "Set-Cookie":
                        cookieHeader
                }
            );

            return;
        }


        /* =================================================
           ADMIN DASHBOARD
        ================================================= */

        if (
            request.method === "GET" &&
            requestPath ===
                "/api/admin/dashboard"
        ) {
            if (
                !isAuthenticated(request)
            ) {
                sendJson(response, 401, {
                    error:
                        "Unauthorized access."
                });

                return;
            }

            sendJson(response, 200, {
                message:
                    "Authenticated successfully."
            });

            return;
        }


        /* =================================================
           USERS API
        ================================================= */

        const usersListMatch =
            requestPath ===
            "/api/admin/users";

        const usersItemMatch =
            requestPath.match(
                /^\/api\/admin\/users\/([a-zA-Z0-9]+)$/
            );

        if (
            usersListMatch &&
            request.method === "GET"
        ) {
            handleGetUsers(
                request,
                response
            );

            return;
        }

        if (
            usersListMatch &&
            request.method === "POST"
        ) {
            await handleCreateUser(
                request,
                response
            );

            return;
        }

        if (
            usersItemMatch &&
            request.method === "PUT"
        ) {
            await handleUpdateUser(
                request,
                response,
                usersItemMatch[1]
            );

            return;
        }

        if (
            usersItemMatch &&
            request.method === "DELETE"
        ) {
            handleDeleteUser(
                request,
                response,
                usersItemMatch[1]
            );

            return;
        }


        /* =================================================
           CONTENT API
        ================================================= */

        const contentListMatch =
            requestPath ===
            "/api/admin/content";

        const contentItemMatch =
            requestPath.match(
                /^\/api\/admin\/content\/([a-zA-Z0-9]+)$/
            );

        if (
            contentListMatch &&
            request.method === "GET"
        ) {
            handleGetContent(
                request,
                response
            );

            return;
        }

        if (
            contentListMatch &&
            request.method === "POST"
        ) {
            await handleCreateContent(
                request,
                response
            );

            return;
        }

        if (
            contentItemMatch &&
            request.method === "PUT"
        ) {
            await handleUpdateContent(
                request,
                response,
                contentItemMatch[1]
            );

            return;
        }

        if (
            contentItemMatch &&
            request.method === "DELETE"
        ) {
            handleDeleteContent(
                request,
                response,
                contentItemMatch[1]
            );

            return;
        }


        /* =================================================
           PUBLIC PAGE CONTENT
        ================================================= */

        const publicPageMatch =
            requestPath.match(
                /^\/api\/pages\/([a-z0-9_-]+)$/
            );

        if (
            publicPageMatch &&
            request.method === "GET"
        ) {
            handleGetPublicPage(
                request,
                response,
                publicPageMatch[1]
            );

            return;
        }


        /* =================================================
           ADMIN PAGE CONTENT
        ================================================= */

        const adminPageMatch =
            requestPath.match(
                /^\/api\/admin\/pages\/([a-z0-9_-]+)$/
            );

        if (
            adminPageMatch &&
            request.method === "GET"
        ) {
            handleGetAdminPage(
                request,
                response,
                adminPageMatch[1]
            );

            return;
        }

        if (
            adminPageMatch &&
            request.method === "PUT"
        ) {
            await handleUpdatePage(
                request,
                response,
                adminPageMatch[1]
            );

            return;
        }


        /* =================================================
           IMAGE UPLOAD
        ================================================= */

        if (
            request.method === "POST" &&
            requestPath ===
                "/api/admin/upload"
        ) {
            await handleImageUpload(
                request,
                response
            );

            return;
        }


        /* =================================================
           PUBLIC PORTFOLIO
        ================================================= */

        if (
            request.method === "GET" &&
            requestPath ===
                "/api/portfolio-projects"
        ) {
            handleGetPublicProjects(
                request,
                response
            );

            return;
        }


        /* =================================================
           ADMIN PORTFOLIO
        ================================================= */

        const projectsListMatch =
            requestPath ===
            "/api/admin/portfolio-projects";

        const projectsItemMatch =
            requestPath.match(
                /^\/api\/admin\/portfolio-projects\/([a-zA-Z0-9]+)$/
            );

        if (
            projectsListMatch &&
            request.method === "GET"
        ) {
            handleGetAdminProjects(
                request,
                response
            );

            return;
        }

        if (
            projectsListMatch &&
            request.method === "POST"
        ) {
            await handleCreateProject(
                request,
                response
            );

            return;
        }

        if (
            projectsItemMatch &&
            request.method === "PUT"
        ) {
            await handleUpdateProject(
                request,
                response,
                projectsItemMatch[1]
            );

            return;
        }

        if (
            projectsItemMatch &&
            request.method === "DELETE"
        ) {
            handleDeleteProject(
                request,
                response,
                projectsItemMatch[1]
            );

            return;
        }


        /* =================================================
           CONTACT
        ================================================= */

        if (
            request.method === "POST" &&
            requestPath ===
                "/api/contact"
        ) {
            await handleContact(
                request,
                response
            );

            return;
        }


        /* =================================================
           HEALTH CHECK
        ================================================= */

        if (
            requestPath ===
                "/api/health" ||
            requestPath === "/healthz"
        ) {
            sendJson(response, 200, {
                status: "ok"
            });

            return;
        }


        /* =================================================
           METHOD CHECK
        ================================================= */

        if (
            request.method !== "GET" &&
            request.method !== "HEAD"
        ) {
            sendJson(response, 405, {
                error:
                    "Method not allowed"
            });

            return;
        }


        /* =================================================
           STATIC FILE SERVING
        ================================================= */

        const requestedFile =
            requestPath === "/"
                ? "index.html"
                : decodeURIComponent(
                    requestPath.slice(1)
                );

        const isImageAsset =
            requestedFile.startsWith(
                "images/"
            );

        if (
            !publicFiles.has(
                requestedFile
            ) &&
            !isImageAsset
        ) {
            sendJson(response, 404, {
                error: "Not found"
            });

            return;
        }

        const filePath =
            path.resolve(
                publicDirectory,
                requestedFile
            );

        serveFile(
            response,
            filePath
        );
    }
);


/* =========================================================
   START SERVER
========================================================= */

server.listen(
    port,
    host,
    () => {
        console.log(
            `PEEMPDESIGNER server running on port ${port}`
        );

        console.log(
            "Resend email:",
            process.env.RESEND_API_KEY
                ? "API key detected"
                : "API key NOT configured"
        );
    }
);
