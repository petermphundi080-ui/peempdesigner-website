// Run this once with: node add-home-defaults.js
// It safely ADDS the "home" page defaults into your existing
// data/pagecontent.json without touching anything already there
// (About, Contact, etc). If a "home" key already exists, this will NOT
// overwrite it -- it'll stop and tell you, so you never lose edits.

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");

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

if (data.home) {
    console.log("A 'home' entry already exists in pagecontent.json -- nothing changed.");
    process.exit(0);
}

data.home = {
    hero_line1: "CREATIVE",
    hero_line2: "GRAPHIC",
    hero_span: "DESIGNER",
    hero_intro: "Hello! I'm Peter Mphundi, a graphic designer.",
    portfolio_button_text: "View portfolio",
    hire_button_text: "Hire Me",
    services_title: "What I do",
    service1_title: "Logo designer",
    service1_desc: "Modern, unique and memorable brand identities",
    service2_title: "Brand identity",
    service2_desc: "Complete branding packages for business",
    service3_title: "Social Media Design",
    service3_desc: "Creative content for Facebook, Instagram and more",
    service4_title: "Print Design",
    service4_desc: "Flyers, posters, business cards and brochures",
    footer_text: "© 2026 PEEMPDESIGNER | Graphic Designer"
};

fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf8");
console.log("Done! 'home' defaults were added to pagecontent.json.");
console.log("Your existing page data was left untouched.");
