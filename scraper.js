// Parses the development applications at the South Australian Wattle Range Council web site and
// places them in a database.
//
// Michael Bone
// 20th October 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const didyoumean = require("didyoumean2");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "https://www.wattlerange.sa.gov.au/page.aspx?u=1158";
const CommentUrl = "mailto:council@wattlerange.sa.gov.au";
// Address information.
let StreetNames = null;
let StreetSuffixes = null;
let SuburbNames = null;
let HundredSuburbNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text)");
            resolve(database);
        });
    });
}
// Inserts a row in the database if it does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function intersect(rectangle1, rectangle2) {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}
// Determines whether containerRectangle completely contains containedRectangle.
function contains(containerRectangle, containedRectangle) {
    return containerRectangle.x <= containedRectangle.x &&
        containerRectangle.y <= containedRectangle.y &&
        containerRectangle.x + containerRectangle.width >= containedRectangle.x + containedRectangle.width &&
        containerRectangle.y + containerRectangle.height >= containedRectangle.y + containedRectangle.height;
}
// Calculates the area of a rectangle.
function getArea(rectangle) {
    return rectangle.width * rectangle.height;
}
// Gets the percentage of horizontal overlap between two rectangles (0 means no overlap and 100
// means 100% overlap).
function getHorizontalOverlapPercentage(rectangle1, rectangle2) {
    if (rectangle1 === undefined || rectangle2 === undefined)
        return 0;
    let startX1 = rectangle1.x;
    let endX1 = rectangle1.x + rectangle1.width;
    let startX2 = rectangle2.x;
    let endX2 = rectangle2.x + rectangle2.width;
    if (startX1 >= endX2 || endX1 <= startX2 || rectangle1.width === 0 || rectangle2.width === 0)
        return 0;
    let intersectionWidth = Math.min(endX1, endX2) - Math.max(startX1, startX2);
    let unionWidth = Math.max(endX1, endX2) - Math.min(startX1, startX2);
    return (intersectionWidth * 100) / unionWidth;
}
// Formats the text as a street.  If the text is not recognised as a street then undefined is
// returned.
function formatStreet(text) {
    if (text === undefined)
        return undefined;
    text = text.trim().toUpperCase();
    let tokens = text.split(" ");
    // Parse the street suffix (this recognises both "ST" and "STREET").
    let token = tokens.pop();
    let streetSuffix = StreetSuffixes[token];
    if (streetSuffix === undefined)
        streetSuffix = Object.values(StreetSuffixes).find(streetSuffix => streetSuffix === token);
    // The text is not considered to be a valid street if it has no street suffix.
    if (streetSuffix === undefined)
        return undefined;
    // Add back the expanded street suffix (for example, this converts "ST" to "STREET").
    tokens.push(streetSuffix);
    // Pop tokens from the end of the array until a valid street name is encountered.
    for (let index = 4; index >= 2; index--) {
        let suburbNames = StreetNames[tokens.slice(-index).join(" ")];
        if (suburbNames !== undefined)
            return { streetName: tokens.join(" "), suburbNames: suburbNames }; // reconstruct the street with the leading house number (and any other prefix text)
    }
    // Pop tokens from the end of the array until a valid street name is encountered (allowing
    // for a spelling error).
    for (let index = 4; index >= 2; index--) {
        let streetNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(StreetNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true });
        if (streetNameMatch !== null) {
            let suburbNames = StreetNames[streetNameMatch];
            tokens.splice(-index, index); // remove elements from the end of the array           
            return { streetName: (tokens.join(" ") + " " + streetNameMatch).trim(), suburbNames: suburbNames }; // reconstruct the street with the leading house number (and any other prefix text)
        }
    }
    return undefined;
}
// Format the address, ensuring that it has a valid suburb, state and post code.
function formatAddress(address) {
    // Handle the special case of a "ü" character in a string.  This means that the string actually
    // contains multiple addresses (so make a best effort to extract one of the addresses).  For
    // example,
    //
    //     5ü5A RALSTONüRALSTON STüST, PENOLAüPENOLA, PENOLA
    //
    // contains the following addresses,
    //
    //     5 RALSTON ST, PENOLA
    //     5A RALSTON ST, PENOLA
    //
    // And, for example,
    //
    //     26ü WOOLSHEDü_ ROADü, GLENCOEüYOUNG, YOUNG
    //
    // contains the following addresses,
    //
    //     26 WOOLSHED ROAD, GLENCOE, YOUNG
    //     _, YOUNG, YOUNG
    if (address.includes("ü")) {
        // ...
    }
    let tokens = address.split(",");
    let token = tokens[tokens.length - 1].trim();
    if (token.startsWith("HD "))
        token = token.substring("HD ".length);
    let hundredNameMatch1 = didyoumean(token, Object.keys(HundredSuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
    let hundredNameMatch2 = null;
    let suburbNameMatch1 = null;
    if (tokens.length >= 2) {
        token = tokens[tokens.length - 2].trim();
        if (token.startsWith("HD ")) {
            token = token.substring("HD ".length);
            hundredNameMatch2 = didyoumean(token, Object.keys(HundredSuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        }
        else {
            suburbNameMatch1 = didyoumean(token, Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        }
    }
    console.log(`hundredNameMatch1=${hundredNameMatch1}, hundredNameMatch2=${hundredNameMatch2}, suburbNameMatch1=${suburbNameMatch1}`);
    if (hundredNameMatch1 !== null)
        console.log(`    1:${hundredNameMatch1}=${HundredSuburbNames[hundredNameMatch1].join(", ")}`);
    if (hundredNameMatch2 !== null)
        console.log(`    2:${hundredNameMatch2}=${HundredSuburbNames[hundredNameMatch2].join(", ")}`);
    let streetNameMatch1 = formatStreet(tokens[tokens.length - 1]);
    let streetNameMatch2 = formatStreet(tokens[tokens.length - 2]);
    let streetNameMatch3 = formatStreet(tokens[tokens.length - 3]);
    if (streetNameMatch1 !== undefined)
        console.log(`        streetNameMatch1=${streetNameMatch1.streetName}; ${streetNameMatch1.suburbNames}`);
    if (streetNameMatch2 !== undefined)
        console.log(`        streetNameMatch2=${streetNameMatch2.streetName}; ${streetNameMatch2.suburbNames}`);
    if (streetNameMatch3 !== undefined)
        console.log(`        streetNameMatch3=${streetNameMatch3.streetName}; ${streetNameMatch3.suburbNames}`);
    return "";
}
// Parses a PDF document.
async function parsePdf(url) {
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.
    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        // Construct a text element for each item from the parsed PDF information.
        let viewport = await page.getViewport(1.0);
        let textContent = await page.getTextContent();
        let operators = await page.getOperatorList();
        // Find the lines.  Each line is actually constructed using a rectangle with a very short
        // height or a very narrow width.
        let lines = [];
        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] !== pdfjs.OPS.constructPath)
                continue;
            let x = operators.argsArray[index][1][1];
            let y = operators.argsArray[index][1][0];
            let width = operators.argsArray[index][1][3];
            let height = operators.argsArray[index][1][2];
            lines.push({ x: x, y: y, width: width, height: height });
        }
        // Convert the lines into a grid of points.
        let points = [];
        for (let line of lines) {
            // Ignore thick lines (since these are probably intented to be drawn as rectangles).
            // And ignore short lines (because these are probably of no consequence).
            if ((line.width > 2 && line.height > 2) || (line.width <= 2 && line.height < 10) || (line.height <= 2 && line.width < 10))
                continue;
            let startPoint = { x: line.x, y: line.y };
            if (!points.some(point => (startPoint.x - point.x) ** 2 + (startPoint.y - point.y) ** 2 < 1))
                points.push(startPoint);
            let endPoint = undefined;
            if (line.height <= 2) // horizontal line
                endPoint = { x: line.x + line.width, y: line.y };
            else // vertical line
                endPoint = { x: line.x, y: line.y + line.height };
            if (!points.some(point => (endPoint.x - point.x) ** 2 + (endPoint.y - point.y) ** 2 < 1))
                points.push(endPoint);
        }
        // Construct cells based on the grid of points.
        let cells = [];
        for (let point of points) {
            // Find the next closest point in the X direction (moving across horizontally with
            // approximately the same Y co-ordinate).
            let closestRightPoint = points.reduce(((previous, current) => (Math.abs(current.y - point.y) < 1 && current.x > point.x && (previous === undefined || (current.x - point.x < previous.x - point.x))) ? current : previous), undefined);
            // Find the next closest point in the Y direction (moving down vertically with
            // approximately the same X co-ordinate).
            let closestDownPoint = points.reduce(((previous, current) => (Math.abs(current.x - point.x) < 1 && current.y > point.y && (previous === undefined || (current.y - point.y < previous.y - point.y))) ? current : previous), undefined);
            // Construct a rectangle from the found points.
            if (closestRightPoint !== undefined && closestDownPoint !== undefined)
                cells.push({ elements: [], x: point.x, y: point.y, width: closestRightPoint.x - point.x, height: closestDownPoint.y - point.y });
        }
        // Sort the cells by approximate Y co-ordinate and then by X co-ordinate.
        let cellComparer = (a, b) => (Math.abs(a.y - b.y) < 2) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
        cells.sort(cellComparer);
        // Find all the text elements.
        let elements = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.
            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            let x = transform[4];
            let y = transform[5] - workaroundHeight;
            let width = item.width;
            let height = workaroundHeight;
            return { text: item.str, x: x, y: y, width: width, height: height };
        });
        // Sort the text elements by approximate Y co-ordinate and then by X co-ordinate.
        let elementComparer = (a, b) => (Math.abs(a.y - b.y) < 1) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
        elements.sort(elementComparer);
        // Allocate each element to an "owning" cell.  An element may extend across several
        // cells (because the PDF parsing may join together multiple sections of text, using
        // multiple intervening spaces; see addFakeSpaces in pdf.worker.js of pdf.js).  If
        // there are multiple cells then allocate the element to the left most cell.
        for (let element of elements) {
            let ownerCell = cells.find(cell => getArea(intersect(cell, element)) > 0); // this finds the left most cell due to the earlier sorting of cells
            if (ownerCell !== undefined)
                ownerCell.elements.push(element);
        }
        // Group the cells into rows.
        let rows = [];
        for (let cell of cells) {
            let row = rows.find(row => Math.abs(row[0].y - cell.y) < 2); // approximate Y co-ordinate match
            if (row === undefined)
                rows.push([cell]); // start a new row
            else
                row.push(cell); // add to an existing row
        }
        // Check that there is at least one row (even if it is just the heading row).
        if (rows.length === 0) {
            let elementSummary = elements.map(element => `[${element.text}]`).join("");
            console.log(`No development applications can be parsed from the current page because no rows were found (based on the grid).  Elements: ${elementSummary}`);
            continue;
        }
        // Ensure the rows are sorted by Y co-ordinate and that the cells in each row are sorted
        // by X co-ordinate (this is really just a safety precaution because the earlier sorting
        // of cells should have already ensured this).
        let rowComparer = (a, b) => (a[0].y > b[0].y) ? 1 : ((a[0].y < b[0].y) ? -1 : 0);
        rows.sort(rowComparer);
        let rowCellComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
        for (let row of rows)
            row.sort(rowCellComparer);
        // Find the heading cells.
        let assessmentCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "ASSESS" && contains(cell, element)));
        let applicationNumberCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DA NUMBER" && contains(cell, element)));
        let addressCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "LOCATION" && contains(cell, element)));
        let descriptionCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DESCRIPTION" && contains(cell, element)));
        let decisionDateCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DECISION" && contains(cell, element)));
        if (applicationNumberCell === undefined) {
            let elementSummary = elements.map(element => `[${element.text}]`).join("");
            console.log(`No development applications can be parsed from the current page because the "DA NUMBER" column heading was not found.  Elements: ${elementSummary}`);
            continue;
        }
        if (addressCell === undefined) {
            let elementSummary = elements.map(element => `[${element.text}]`).join("");
            console.log(`No development applications can be parsed from the current page because the "LOCATION" column heading was not found.  Elements: ${elementSummary}`);
            continue;
        }
        // Parse any elements that intersect more than one cell (and split them into multiple
        // elements).
        for (let row of rows) {
            for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
                let cell = row[columnIndex];
                let overhangElements = cell.elements.filter(element => !contains(cell, element));
                for (let overhangElement of overhangElements) {
                    // Find the companions (ie. roughly aligned with the same Y co-ordinate) of an
                    // element that intersects more than one cell.
                    let alignedElements = [];
                    for (let index = cell.elements.length - 1; index >= 0; index--) {
                        if (Math.abs(cell.elements[index].y - overhangElement.y) < 5) { // elements with approximately the same Y co-ordinate
                            alignedElements.unshift(cell.elements[index]);
                            cell.elements.splice(index, 1); // remove the element
                        }
                    }
                    // Join the aligned elements together and parse the resulting text.  Construct
                    // elements for the resulting text and add those elements to appropriate cells
                    // (these new elements effectively replace the old, removed elements).
                    let text = alignedElements.map(element => element.text).join("").trim();
                    if (text === "")
                        continue;
                    if (getHorizontalOverlapPercentage(cell, assessmentCell) > 90) {
                        // Parse the text into an assessment, a VG number and an application
                        // number.
                        let tokens = text.split("   ").map(token => token.trim()).filter(token => token !== "");
                        let [assessmentText, vgNumberText, applicationNumberText] = tokens;
                        cell.elements.push({ text: assessmentText, x: alignedElements[0].x, y: alignedElements[0].y, width: (cell.x + cell.width - alignedElements[0].x), height: alignedElements[0].height });
                        if (columnIndex + 1 < row.length && vgNumberText !== undefined) {
                            let vgNumberCell = row[columnIndex + 1];
                            vgNumberCell.elements.push({ text: vgNumberText, x: vgNumberCell.x, y: alignedElements[0].y, width: vgNumberCell.width, height: alignedElements[0].height });
                        }
                        if (columnIndex + 2 < row.length && applicationNumberText !== undefined) {
                            let applicationNumberCell = row[columnIndex + 2];
                            applicationNumberCell.elements.push({ text: applicationNumberText, x: applicationNumberCell.x, y: alignedElements[0].y, width: applicationNumberCell.width, height: alignedElements[0].height });
                        }
                    }
                    else if (getHorizontalOverlapPercentage(cell, descriptionCell) > 90) {
                        // Parse the text into a description and a decision date.
                        let tokens = text.split("   ").map(token => token.trim()).filter(token => token !== "");
                        let [descriptionText, decisionDateText] = tokens;
                        cell.elements.push({ text: descriptionText, x: alignedElements[0].x, y: alignedElements[0].y, width: (cell.x + cell.width - alignedElements[0].x), height: alignedElements[0].height });
                        if (columnIndex + 1 < row.length && decisionDateText !== undefined) {
                            let decisionDateCell = row[columnIndex + 1];
                            decisionDateCell.elements.push({ text: decisionDateText, x: decisionDateCell.x, y: alignedElements[0].y, width: decisionDateCell.width, height: alignedElements[0].height });
                        }
                    }
                    else if (getHorizontalOverlapPercentage(cell, decisionDateCell) > 90) {
                        // Parse the text into a decision date.
                        let tokens = text.split("   ").map(token => token.trim()).filter(token => token !== "");
                        let [decisionDateText] = tokens;
                        cell.elements.push({ text: decisionDateText, x: alignedElements[0].x, y: alignedElements[0].y, width: (cell.x + cell.width - alignedElements[0].x), height: alignedElements[0].height });
                    }
                }
            }
        }
        // Re-sort the elements in each cell (now that elements have been re-constructed and then
        // added to different cells).
        for (let row of rows)
            for (let cell of row)
                cell.elements.sort(elementComparer);
        // Try to extract a development application from each row (some rows, such as the heading
        // row, will not actually contain a development application).
        for (let row of rows) {
            let rowApplicationNumberCell = row.find(cell => getHorizontalOverlapPercentage(cell, applicationNumberCell) > 90);
            let rowAddressCell = row.find(cell => getHorizontalOverlapPercentage(cell, addressCell) > 90);
            let rowDescriptionCell = row.find(cell => getHorizontalOverlapPercentage(cell, descriptionCell) > 90);
            let rowDecisionDateCell = row.find(cell => getHorizontalOverlapPercentage(cell, decisionDateCell) > 90);
            let applicationNumber = rowApplicationNumberCell.elements.map(element => element.text).join("").trim();
            let address = rowAddressCell.elements.map(element => element.text).join("").replace(/\s\s+/g, " ").trim();
            let description = (rowDescriptionCell === undefined) ? "" : rowDescriptionCell.elements.map(element => element.text).join("").replace(/\s\s+/g, " ").trim();
            let decisionDateText = (rowDecisionDateCell === undefined) ? "" : rowDecisionDateCell.elements.map(element => element.text).join("").trim();
            if (!/[0-9]+\/[0-9]+\/[0-9]/.test(applicationNumber))
                continue;
            address = formatAddress(address);
            if (address === "")
                continue;
            if (description === "")
                description = "NO DESCRIPTION PROVIDED";
            let decisionDate = moment(decisionDateText.replace(/\./g, "/"), "D/MM/YYYY", true);
            console.log(`applicationNumber=[${applicationNumber}] address=[${address}] description=[${description}] decisionDate=[${decisionDate}]`);
            developmentApplications.push({
                applicationNumber: applicationNumber,
                address: address,
                description: ((description === "") ? "NO DESCRIPTION PROVIDED" : description),
                informationUrl: url,
                commentUrl: CommentUrl,
                scrapeDate: moment().format("YYYY-MM-DD")
            });
        }
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Read the street names.
    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName); // several suburbs may exist for the same street name
    }
    // Read the street suffixes.
    StreetSuffixes = {};
    for (let line of fs.readFileSync("streetsuffixes.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetSuffixTokens = line.toUpperCase().split(",");
        StreetSuffixes[streetSuffixTokens[0].trim()] = streetSuffixTokens[1].trim();
    }
    // Read the suburb names and hundred names.
    SuburbNames = {};
    HundredSuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        let suburbName = suburbTokens[0].trim();
        SuburbNames[suburbName] = suburbTokens[1].trim();
        if (suburbName.startsWith("MOUNT ")) {
            SuburbNames["MT " + suburbName.substring("MOUNT ".length)] = suburbTokens[1].trim();
            SuburbNames["MT." + suburbName.substring("MOUNT ".length)] = suburbTokens[1].trim();
            SuburbNames["MT. " + suburbName.substring("MOUNT ".length)] = suburbTokens[1].trim();
        }
        for (let hundredName of suburbTokens[2].split(";")) {
            hundredName = hundredName.trim();
            (HundredSuburbNames[hundredName] || (HundredSuburbNames[hundredName] = [])).push(suburbTokens[1].trim()); // several suburbs may exist for the same hundred name
            if (hundredName.startsWith("MOUNT ")) {
                let mountHundredName = "MT " + hundredName.substring("MOUNT ".length);
                (HundredSuburbNames[mountHundredName] || (HundredSuburbNames[mountHundredName] = [])).push(suburbTokens[1].trim()); // several suburbs may exist for the same hundred name
                mountHundredName = "MT." + hundredName.substring("MOUNT ".length);
                (HundredSuburbNames[mountHundredName] || (HundredSuburbNames[mountHundredName] = [])).push(suburbTokens[1].trim()); // several suburbs may exist for the same hundred name
                mountHundredName = "MT. " + hundredName.substring("MOUNT ".length);
                (HundredSuburbNames[mountHundredName] || (HundredSuburbNames[mountHundredName] = [])).push(suburbTokens[1].trim()); // several suburbs may exist for the same hundred name
            }
        }
    }
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Retrieve the page that contains the links to the PDFs.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    let pdfUrls = [];
    for (let element of $("td.u6ListTD a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl);
        if (!pdfUrls.some(url => url === pdfUrl.href)) // avoid duplicates
            pdfUrls.push(pdfUrl.href);
    }
    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }
    pdfUrls.reverse();
    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).
    let selectedPdfUrls = pdfUrls;
    // let selectedPdfUrls: string[] = [];
    // selectedPdfUrls.push(pdfUrls.shift());
    // if (pdfUrls.length > 0)
    //     selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    // if (getRandom(0, 2) === 0)
    //     selectedPdfUrls.reverse();
    // console.log("Testing PDF.");
    // selectedPdfUrls = [ "https://www.wattlerange.sa.gov.au/webdata/resources/files/Stats%20May%2015.pdf" ];
    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0dBQWdHO0FBQ2hHLDZCQUE2QjtBQUM3QixFQUFFO0FBQ0YsZUFBZTtBQUNmLG9CQUFvQjtBQUVwQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQyxpQ0FBaUM7QUFDakMsb0NBQW9DO0FBQ3BDLDBDQUEwQztBQUUxQyxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFFbEIsTUFBTSwwQkFBMEIsR0FBRyxvREFBb0QsQ0FBQztBQUN4RixNQUFNLFVBQVUsR0FBRyxzQ0FBc0MsQ0FBQztBQUkxRCx1QkFBdUI7QUFFdkIsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3ZCLElBQUksY0FBYyxHQUFJLElBQUksQ0FBQztBQUMzQixJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFDdkIsSUFBSSxrQkFBa0IsR0FBRyxJQUFJLENBQUM7QUFFOUIsOEJBQThCO0FBRTlCLEtBQUssVUFBVSxrQkFBa0I7SUFDN0IsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbkQsUUFBUSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUU7WUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQyx3S0FBd0ssQ0FBQyxDQUFDO1lBQ3ZMLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN0QixDQUFDLENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELDhEQUE4RDtBQUU5RCxLQUFLLFVBQVUsU0FBUyxDQUFDLFFBQVEsRUFBRSxzQkFBc0I7SUFDckQsT0FBTyxJQUFJLE9B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