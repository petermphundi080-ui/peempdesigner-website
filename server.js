const http = require("http");
const fs = require("fs");
const path = require("path");
const { Resend } = require("resend");
const cookie = require("cookie");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const usersStore = require("./lib/usersstore");
const contentStore = require("./lib/contentstore");
const pageContentStore = require("./lib/pagecontentstore");

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

// Clean up expired sessions
setInterval(() => {
    const now = Date.now();

    for (const [id, expiry] of activeSessions) {
        if (now > expiry) {
            activeSessions.delete(id);
        }
    }
}, 60 * 60 * 1000);

function isAdminLoginRateLimited(clientIp) {
    const now = Date.now();

    const attempts = (
        adminLoginAttempts.get(clientIp) || []
    ).filter(
        timestamp => now - timestamp < adminLoginWindowMs
    );

    attempts.push(now);

    adminLoginAttempts.set(clientIp, attempts);

    return attempts.length > adminLoginLimit;
}

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

/* =========================================================
   RESEND EMAIL
========================================================= */

function createMailer() {
    if (!process.env.RESEND_API_KEY) {
        console.error(
            "Email Error: Missing RESEND_API_KEY."
        );

        return null;
    }

    return new Resend(
        process.env.RESEND_API_KEY.trim()
    );
}

async function handleContact(request, response) {
    try {
        const contentType =
            request.headers["content-type"] || "";

        if (!contentType.includes("application/json")) {
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

        const emailPattern =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(email)) {
            sendJson(response, 400, {
                error:
                    "Please enter a valid email address."
            });

            return;
        }

        const resend = createMailer();

        if (
            !resend ||
            !process.env.EMAIL_TO ||
            !process.env.EMAIL_FROM
        ) {
            console.error(
                "Email service is not configured."
            );

            sendJson(response, 503, {
                error:
                    "Email service not configured."
            });

            return;
        }

        const safeName =
            name.replace(/[\r\n]+/g, " ");

        const safeProject =
            project.replace(/[\r\n]+/g, " ");

        const { data, error } =
            await resend.emails.send({
                from:
                    process.env.EMAIL_FROM.trim(),

                to:
                    process.env.EMAIL_TO.trim(),

                replyTo: email,

                subject:
                    `${safeProject} inquiry from ${safeName}`,

                text:
                    `Name: ${name}\n` +
                    `Email: ${email}\n` +
                    `Project: ${project}\n\n` +
                    `Message:\n${message}`
            });

        if (error) {
            console.error(
                "Resend error:",
                error
            );

            sendJson(response, 500, {
                error:
                    "Unable to send message."
            });

            return;
        }

        console.log(
            "Email sent successfully! ID:",
            data?.id
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
                "Unable to send message."
        });
    }
}

/* =========================================================
   USERS CRUD
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
   CONTENT CRUD
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
   SERVER
========================================================= */

const server = http.createServer(
    async (request, response) => {

        const responseTimeoutMs =
            Number(
                process.env.RESPONSE_TIMEOUT_MS
            ) || 30000;

        response.setTimeout(
            responseTimeoutMs,
            () => response.destroy()
        );

        if (request.method === "OPTIONS") {
            setSecurityHeaders(response);

            response.writeHead(204);
            response.end();

            return;
        }

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

        /* CONTACT RATE LIMIT */

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

        /* ADMIN LOGIN */

        if (
            request.method === "POST" &&
            requestPath === "/api/admin/login"
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
                    await readRequestBody(request)
                );

                const username =
                    typeof body.username === "string"
                        ? body.username
                        : "";

                const password =
                    typeof body.password === "string"
                        ? body.password
                        : "";

                const usernameMatches =
                    username ===
                    process.env.ADMIN_USER;

                const passwordMatches =
                    usernameMatches &&
                    process.env.ADMIN_PASS_HASH
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
                        crypto
                            .randomBytes(32)
                            .toString("hex");

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
                    sendJson(response, 401, {
                        error:
                            "Invalid admin credentials."
                    });
                }

            } catch (e) {
                sendJson(response, 400, {
                    error:
                        "Invalid request payload."
                });
            }

            return;
        }

        /* ADMIN LOGOUT */

        if (
            request.method === "POST" &&
            requestPath === "/api/admin/logout"
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

        /* ADMIN DASHBOARD */

        if (
            request.method === "GET" &&
            requestPath ===
                "/api/admin/dashboard"
        ) {
            if (!isAuthenticated(request)) {
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

        /* USERS API */

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

        /* CONTENT API */

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

        /* PUBLIC PAGE CONTENT */

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

        /* ADMIN PAGE CONTENT */

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

        /* CONTACT */

        if (
            request.method === "POST" &&
            requestPath === "/api/contact"
        ) {
            await handleContact(
                request,
                response
            );

            return;
        }

        /* HEALTH CHECK */

        if (
            requestPath === "/api/health" ||
            requestPath === "/healthz"
        ) {
            sendJson(response, 200, {
                status: "ok"
            });

            return;
        }

        /* STATIC FILES */

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

server.listen(
    port,
    host,
    () => {
        console.log(
            `PEEMPDESIGNER server running on port ${port}`
        );
    }
);
