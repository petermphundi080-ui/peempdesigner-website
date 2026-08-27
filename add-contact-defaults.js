// Run this once with: node add-contact-defaults.js
// It safely ADDS the "contact" page defaults into your existing
// data/pagecontent.json without touching anything already there (like About).
// If a "contact" key already exists, this will NOT overwrite it -- it'll stop
// and tell you, so you never lose edits by accident.

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");

// Find the page content file regardless of exact casing (pagecontent.json,
// pageContent.json, etc. all work), since Windows filenames can vary.
let dataFile = null;
if (fs.existsSync(dataDir)) {
    const match = fs.readdirSync(dataDir).find(
        (name) => name.toLowerCase() === "pagecontent.json"
    );
    if (match) {
        dataFile = path.join(dataDir, match);
    }
}

if (!dataFile) {
    console.error("Could not find a pagecontent.json file inside the 'data' folder. Make sure you run this from your project root (the same folder as server.js).");
    process.exit(1);
}

console.log("Using file:", dataFile);


const raw = fs.readFileSync(dataFile, "utf8");
let data;
try {
    data = JSON.parse(raw);
} catch (err) {
    console.error("pagecontent.json is not valid JSON. Please fix it before running this script.");
    process.exit(1);
}

if (data.contact) {
    console.log("A 'contact' entry already exists in pagecontent.json -- nothing changed.");
    process.exit(0);
}

data.contact = {
    hero_tag: "CONTACT",
    hero_heading: "Let's Work Together.",
    hero_paragraph: "Have a project in mind? Let's create something professional, creative, and memorable.",
    info_heading: "Get In Touch.",
    form_heading: "Send a Message.",
    submit_button_text: "Send Message →",
    footer_text1: "© 2026 Peempdesigner. All Rights Reserved.",
    footer_text2: "Creating designs that make an impact."
};

fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf8");
console.log("Done! 'contact' defaults were added to pagecontent.json.");
console.log("Your existing 'about' data was left untouched.");
