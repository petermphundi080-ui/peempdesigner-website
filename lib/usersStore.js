const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// Make sure the data folder and file exist before we ever try to read/write.
function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, "[]", "utf8");
    }
}

function readUsers() {
    ensureFile();
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error("users.json is corrupted, resetting to empty list:", err);
        return [];
    }
}

// Write is synchronous and whole-file, which is fine for small admin user lists.
// It's simple and avoids partial-write corruption for this scale of data.
function writeUsers(users) {
    ensureFile();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAllUsers() {
    return readUsers();
}

function getUserById(id) {
    return readUsers().find(u => u.id === id) || null;
}

function createUser({ name, email, status }) {
    name = typeof name === "string" ? name.trim() : "";
    email = typeof email === "string" ? email.trim().toLowerCase() : "";
    status = status === "suspended" ? "suspended" : "active";

    if (!name) throw new Error("Name is required.");
    if (!email || !isValidEmail(email)) throw new Error("A valid email is required.");

    const users = readUsers();

    if (users.some(u => u.email === email)) {
        throw new Error("A user with this email already exists.");
    }

    const newUser = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        email,
        status,
        created_at: new Date().toISOString()
    };

    users.push(newUser);
    writeUsers(users);
    return newUser;
}

function updateUser(id, { name, email, status }) {
    const users = readUsers();
    const index = users.findIndex(u => u.id === id);
    if (index === -1) throw new Error("User not found.");

    const existing = users[index];

    if (name !== undefined) {
        name = typeof name === "string" ? name.trim() : "";
        if (!name) throw new Error("Name cannot be empty.");
        existing.name = name;
    }

    if (email !== undefined) {
        email = typeof email === "string" ? email.trim().toLowerCase() : "";
        if (!email || !isValidEmail(email)) throw new Error("A valid email is required.");
        if (users.some(u => u.email === email && u.id !== id)) {
            throw new Error("A user with this email already exists.");
        }
        existing.email = email;
    }

    if (status !== undefined) {
        if (status !== "active" && status !== "suspended") {
            throw new Error("Status must be 'active' or 'suspended'.");
        }
        existing.status = status;
    }

    existing.updated_at = new Date().toISOString();

    users[index] = existing;
    writeUsers(users);
    return existing;
}

function deleteUser(id) {
    const users = readUsers();
    const index = users.findIndex(u => u.id === id);
    if (index === -1) throw new Error("User not found.");

    const [removed] = users.splice(index, 1);
    writeUsers(users);
    return removed;
}

module.exports = {
    getAllUsers,
    getUserById,
    createUser,
    updateUser,
    deleteUser
};