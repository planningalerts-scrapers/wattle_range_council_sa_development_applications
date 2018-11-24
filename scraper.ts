// Parses the development applications at the South Australian Wattle Range Council web site and
// places them in a database.
//
// Michael Bone
// 20th October 2018

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import * as didyoumean from "didyoumean2";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.wattlerange.sa.gov.au/page.aspx?u=1158";
const CommentUrl = "mailto:council@wattlerange.sa.gov.au";

declare const process: any;

// Address information.

let StreetNames = null;
let StreetSuffixes  = null;
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
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// A 2D point.

interface Point {
    x: number,
    y: number
}

// A bounding rectangle.

interface Rectangle {
    x: number,
    y: number,
    width: number,
    height: number
}

// An element (consisting of text and intersecting cells) in a PDF document.

interface Element extends Rectangle {
    text: string
}

// A cell in a grid (owning zero, one or more elements).

interface Cell extends Rectangle {
    elements: Element[]
}

// Reads all the address information into global objects.

function readAddressInformation() {
    // Read the street names.

    StreetNames = {}
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName);  // several suburbs may exist for the same street name
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
            (HundredSuburbNames[hundredName] || (HundredSuburbNames[hundredName] = [])).push(suburbName);  // several suburbs may exist for the same hundred name
            if (hundredName.startsWith("MOUNT ")) {
                let mountHundredName = "MT " + hundredName.substring("MOUNT ".length);
                (HundredSuburbNames[mountHundredName] || (HundredSuburbNames[mountHundredName] = [])).push(suburbName);  // several suburbs may exist for the same hundred name
                mountHundredName = "MT." + hundredName.substring("MOUNT ".length);
                (HundredSuburbNames[mountHundredName] || (HundredSuburbNames[mountHundredName] = [])).push(suburbName);  // several suburbs may exist for the same hundred name
                mountHundredName = "MT. " + hundredName.substring("MOUNT ".length);
                (HundredSuburbNames[mountHundredName] || (HundredSuburbNames[mountHundredName] = [])).push(suburbName);  // several suburbs may exist for the same hundred name
            }
        }
    }
}

// Constructs a rectangle based on the intersection of the two specified rectangles.

function intersect(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
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

function contains(containerRectangle: Rectangle, containedRectangle: Rectangle) {
    return containerRectangle.x <= containedRectangle.x &&
        containerRectangle.y <= containedRectangle.y &&
        containerRectangle.x + containerRectangle.width >= containedRectangle.x + containedRectangle.width &&
        containerRectangle.y + containerRectangle.height >= containedRectangle.y + containedRectangle.height;
}

// Calculates the area of a rectangle.

function getArea(rectangle: Rectangle) {
    return rectangle.width * rectangle.height;
}

// Gets the percentage of horizontal overlap between two rectangles (0 means no overlap and 100
// means 100% overlap).

function getHorizontalOverlapPercentage(rectangle1: Rectangle, rectangle2: Rectangle) {
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

    let tokens = text.trim().toUpperCase().split(" ");

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

    // Extract tokens from the end of the array until a valid street name is encountered (this
    // looks for an exact match).

    for (let index = 4; index >= 2; index--) {
        let suburbNames = StreetNames[tokens.slice(-index).join(" ")];
        if (suburbNames !== undefined)
            return { streetName: tokens.join(" "), suburbNames: suburbNames };  // reconstruct the street with the leading house number (and any other prefix text)
    }

    // Extract tokens from the end of the array until a valid street name is encountered (this
    // allows for a spelling error).

    for (let index = 4; index >= 2; index--) {
        let streetNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(StreetNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true });
        if (streetNameMatch !== null) {
            let suburbNames = StreetNames[streetNameMatch];
            tokens.splice(-index, index);  // remove elements from the end of the array           
            return { streetName: (tokens.join(" ") + " " + streetNameMatch).trim(), suburbNames: suburbNames };  // reconstruct the street with the leading house number (and any other prefix text)
        }
    }

    return undefined;
}

// Split an address (ie. an address which actually contains multiple addresses due to the presence
// of the "ü" character) and select one of the resulting addresses.

function splitAddress(address) {
    if (!address.includes("ü"))
        return address;

    // Handle the special case of a "ü" character in a string.  This means that the string
    // actually contains multiple addresses (so make a best effort to extract one of the
    // addresses).  For example,
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

    let address1Tokens = [];
    let address2Tokens = [];

    let tokens = address.split(",");
    for (let token of tokens) {
        if (token.includes("ü")) {  // for example, "5ü5A RALSTONüRALSTON STüST"
            let text1 = "";
            let text2 = "";
            let items = token.split(" ");
            for (let item of items) {  // for example, "5ü5A"
                let parts = item.split("ü");
                text1 += " " + parts[0];
                if (parts.length >= 2)
                    text2 += " " + parts[1];
            }
            address1Tokens.push(" " + text1.trim());  // for example, "5 RALSTON ST, PENOLA"
            address2Tokens.push(" " + text2.trim());  // for example, "5A RALSTON ST, PENOLA"
        } else {
            address1Tokens.push(token);
            address2Tokens.push(token);
        }
    }

    let address1 = address1Tokens.join(",")
    let address2 = address2Tokens.join(",")

    // Choose the longer address (because it is the one most likely to have a street name).

    return (address1.length > address2.length) ? address1 : address2;
}

// Format the address, ensuring that it has a valid suburb, state and post code.

function formatAddress(address) {
    // Allow for a few special cases (ie. road type suffixes and multiple addresses).

    address = address.replace(/ TCE NTH/g, " TERRACE NORTH").replace(/ TCE STH/g, " TERRACE SOUTH").replace(/ TCE EAST/g, " TERRACE EAST").replace(/ TCE WEST/g, " TERRACE WEST");
    if (address.includes("ü"))
        address = splitAddress(address);  // choose one of multiple addresses

    // Break the address up based on commas (the main components of the address are almost always
    // separated by commas).

    let tokens = address.split(",");

    // Find the location of the street name in the tokens.

    let streetNameIndex = 3;
    let formattedStreet = formatStreet(tokens[tokens.length - streetNameIndex]);  // the street name is most likely in the third to last token (so try this first)
    if (formattedStreet === undefined) {
        streetNameIndex = 2;
        formattedStreet = formatStreet(tokens[tokens.length - streetNameIndex]);  // try the second to last token (occasionally happens)
        if (formattedStreet === undefined) {
            streetNameIndex = 4;
            formattedStreet = formatStreet(tokens[tokens.length - streetNameIndex]);  // try the fourth to last token (rare)
            if (formattedStreet === undefined)
                return address;  // if a street name is not found then give up
        }
    }

    // If there is one token after the street name then assume that it is a hundred name.  For
    // example,
    //
    // LOT 15, SECTION P.2299,  KIRIP RD, HINDMARSH

    if (streetNameIndex === 2) {
        let hundredSuburbNames = [];

        let token = tokens[tokens.length - 1].trim();
        if (token.startsWith("HD "))
            token = token.substring("HD ".length).trim();

        let hundredNameMatch = didyoumean(token, Object.keys(HundredSuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (hundredNameMatch !== null)
            hundredSuburbNames = HundredSuburbNames[hundredNameMatch];

        // Construct the intersection of two arrays of suburb names (ignoring the array of suburb
        // names derived from the hundred name if it is empty).

        let intersectingSuburbNames = formattedStreet.suburbNames
            .filter(suburbName => hundredSuburbNames === null || hundredSuburbNames.indexOf(suburbName) >= 0);
        let suburbName = (intersectingSuburbNames.length === 0) ? formattedStreet.suburbNames[0] : intersectingSuburbNames[0];

        // Reconstruct the full address using the formatted street name and determined suburb name.

        tokens = tokens.slice(0, tokens.length - streetNameIndex);
        tokens.push(formattedStreet.streetName);
        tokens.push(SuburbNames[suburbName]);
        return tokens.join(", ");
    }

    // If there are two tokens after the street name then assume that they are the suburb name
    // followed by the hundred name (however, if the suburb name is prefixed by "HD " then assume
    // that they are both hundred names).  For example,
    //
    // LOT 1, 2 BAKER ST, SOUTHEND, RIVOLI BAY
    // LOT 4, SECTION ,  KIRIP RD, HD HINDMARSH, HINDMARSH
    //
    // If there are three tokens after the street name then ignore the first token and assume that
    // the second and third tokens are the suburb name followed by the hundred name (however, if
    // the suburb name is prefixed by "HD " then assume that they are both hundred names).  For
    // example,
    //
    // SECTION P.399, 10 SOMERVILLE ST,S.O.T.P, BEACHPORT, RIVOLI BAY
    // LOT 4, 20 SOMERVILLE ST, S.O.T.P., HD RIVOLI BAY, RIVOLI BAY

    if (streetNameIndex === 3 || streetNameIndex === 4) {
        let hundredSuburbNames1 = [];
        let hundredSuburbNames2 = [];
        let suburbNames = [];

        let token = tokens[tokens.length - 1].trim();
        if (token.startsWith("HD "))
            token = token.substring("HD ".length).trim();

        let hundredNameMatch = didyoumean(token, Object.keys(HundredSuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (hundredNameMatch !== null)
            hundredSuburbNames1 = HundredSuburbNames[hundredNameMatch];

        // The other token is usually a suburb name, but is sometimes a hundred name (as indicated
        // by a "HD " prefix).

        token = tokens[tokens.length - 2].trim();
        if (token.startsWith("HD ")) {
            token = token.substring("HD ".length).trim();
            let hundredNameMatch = didyoumean(token, Object.keys(HundredSuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
            if (hundredNameMatch !== null)
                hundredSuburbNames2 = HundredSuburbNames[hundredNameMatch];
        } else {
            let suburbNameMatch = didyoumean(token, Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
            if (suburbNameMatch !== null)
                suburbNames = [ suburbNameMatch ];
        }

        // Construct the intersection of all the different arrays of suburb names (ignoring any
        // arrays that are empty).

        let intersectingSuburbNames = formattedStreet.suburbNames
            .filter(suburbName => hundredSuburbNames1.length === 0 || hundredSuburbNames1.indexOf(suburbName) >= 0)
            .filter(suburbName => hundredSuburbNames2.length === 0 || hundredSuburbNames2.indexOf(suburbName) >= 0)
            .filter(suburbName => suburbNames.length === 0 || suburbNames.indexOf(suburbName) >= 0)
        let suburbName = (intersectingSuburbNames.length === 0) ? formattedStreet.suburbNames[0] : intersectingSuburbNames[0];

        // Reconstruct the full address using the formatted street name and determined suburb name.

        tokens = tokens.slice(0, tokens.length - streetNameIndex);
        tokens.push(formattedStreet.streetName);
        tokens.push(SuburbNames[suburbName]);
        return tokens.join(", ");
    }

    return address;
}

// Parses any elements that intersect more than one cell (and splits them into multiple elements).

function removeOverhangingElements(rows: Cell[][], assessmentCell: Cell, descriptionCell: Cell, decisionDateCell: Cell) {
    for (let row of rows) {
        for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
            let cell = row[columnIndex];

            let overhangElements = cell.elements.filter(element => !contains(cell, element));
            for (let overhangElement of overhangElements) {
                // Find the companions (ie. roughly aligned with the same Y co-ordinate) of an
                // element that intersects more than one cell.

                let alignedElements: Element[] = [];
                for (let index = cell.elements.length - 1; index >= 0; index--) {
                    if (Math.abs(cell.elements[index].y - overhangElement.y) < 5) {  // elements with approximately the same Y co-ordinate
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
                } else if (getHorizontalOverlapPercentage(cell, descriptionCell) > 90) {
                    // Parse the text into a description and a decision date.

                    let tokens = text.split("   ").map(token => token.trim()).filter(token => token !== "");
                    let [descriptionText, decisionDateText] = tokens;
                    cell.elements.push({ text: descriptionText, x: alignedElements[0].x, y: alignedElements[0].y, width: (cell.x + cell.width - alignedElements[0].x), height: alignedElements[0].height });
                    if (columnIndex + 1 < row.length && decisionDateText !== undefined) {
                        let decisionDateCell = row[columnIndex + 1];
                        decisionDateCell.elements.push({ text: decisionDateText, x: decisionDateCell.x, y: alignedElements[0].y, width: decisionDateCell.width, height: alignedElements[0].height });
                    }
                } else if (getHorizontalOverlapPercentage(cell, decisionDateCell) > 90) {
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

    let elementComparer = (a, b) => (Math.abs(a.y - b.y) < 1) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
    for (let row of rows)
        for (let cell of row)
            cell.elements.sort(elementComparer);
}

// Examines all the lines in a page of a PDF and constructs cells (ie. rectangles) based on those
// lines.

async function parseCells(page) {
    let operators = await page.getOperatorList();

    // Find the lines.  Each line is actually constructed using a rectangle with a very short
    // height or a very narrow width.

    let lines: Rectangle[] = [];

    for (let index = 0; index < operators.fnArray.length; index++) {
        if (operators.fnArray[index] !== pdfjs.OPS.constructPath)
            continue;
            
        let x = operators.argsArray[index][1][1];
        let y = operators.argsArray[index][1][0];
        let width = operators.argsArray[index][1][3];
        let height = operators.argsArray[index][1][2];

        lines.push({x: x, y: y, width: width, height: height});
    }

    // Convert the lines into a grid of points.

    let points: Point[] = [];

    for (let line of lines) {
        // Ignore thick lines (since these are probably intented to be drawn as rectangles).
        // And ignore short lines (because these are probably of no consequence).

        if ((line.width > 2 && line.height > 2) || (line.width <= 2 && line.height < 10) || (line.height <= 2 && line.width < 10))
            continue;

        let startPoint: Point = { x: line.x, y: line.y };
        if (!points.some(point => (startPoint.x - point.x) ** 2 + (startPoint.y - point.y) ** 2 < 1))
            points.push(startPoint);

        let endPoint: Point = undefined;
        if (line.height <= 2)  // horizontal line
            endPoint = { x: line.x + line.width, y: line.y };
        else  // vertical line
            endPoint = { x: line.x, y: line.y + line.height };

        if (!points.some(point => (endPoint.x - point.x) ** 2 + (endPoint.y - point.y) ** 2 < 1))
            points.push(endPoint);
    }

    // Construct cells based on the grid of points.

    let cells: Cell[] = [];
    for (let point of points) {
        // Find the next closest point in the X direction (moving across horizontally with
        // approximately the same Y co-ordinate).

        let closestRightPoint = points.reduce(
            ((previous, current) => (Math.abs(current.y - point.y) < 1 && current.x > point.x && (previous === undefined || (current.x - point.x < previous.x - point.x))) ? current : previous),
            undefined);

        // Find the next closest point in the Y direction (moving down vertically with
        // approximately the same X co-ordinate).

        let closestDownPoint = points.reduce(
            ((previous, current) => (Math.abs(current.x - point.x) < 1 && current.y > point.y && (previous === undefined || (current.y - point.y < previous.y - point.y))) ? current : previous),
            undefined);

        // Construct a rectangle from the found points.

        if (closestRightPoint !== undefined && closestDownPoint !== undefined)
            cells.push({ elements: [], x: point.x, y: point.y, width: closestRightPoint.x - point.x, height: closestDownPoint.y - point.y });
    }

    // Sort the cells by approximate Y co-ordinate and then by X co-ordinate.

    let cellComparer = (a, b) => (Math.abs(a.y - b.y) < 2) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
    cells.sort(cellComparer);
    return cells;
}

// Parses the text elements from a page of a PDF.

async function parseElements(page) {
    let viewport = await page.getViewport(1.0);
    let textContent = await page.getTextContent();

    // Find all the text elements.

    let elements: Element[] = textContent.items.map(item => {
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
    return elements;
}

// Parses a PDF document.

async function parsePdf(url: string) {
    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has the details of multiple applications.

    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);

        // Construct cells (ie. rectangles) based on the horizontal and vertical line segments
        // in the PDF page.

        let cells = await parseCells(page);

        // Construct elements based on the text in the PDF page.

        let elements = await parseElements(page);

        // Allocate each element to an "owning" cell.  An element may extend across several
        // cells (because the PDF parsing may join together multiple sections of text, using
        // multiple intervening spaces; see addFakeSpaces in pdf.worker.js of pdf.js).  If
        // there are multiple cells then allocate the element to the left most cell.

        for (let element of elements) {
            let ownerCell = cells.find(cell => getArea(intersect(cell, element)) > 0);  // this finds the left most cell due to the earlier sorting of cells
            if (ownerCell !== undefined)
                ownerCell.elements.push(element);
        }

        // Group the cells into rows.

        let rows: Cell[][] = [];

        for (let cell of cells) {
            let row = rows.find(row => Math.abs(row[0].y - cell.y) < 2);  // approximate Y co-ordinate match
            if (row === undefined)
                rows.push([ cell ]);  // start a new row
            else
                row.push(cell);  // add to an existing row
        }

        // Check that there is at least one row (even if it is just the heading row).

        if (rows.length === 0) {
            let elementSummary = elements.map(element => `[${element.text}]`).join("");
            console.log(`No development applications can be parsed from the current page because no rows were found (based on the grid).  Elements: ${elementSummary}`);
            continue;
        }

        // Ensure the rows are sorted by Y co-ordinate and that the cells in each row are sorted
        // by X co-ordinate (this is really just a safety precaution because the earlier sorting
        // of cells in the parseCells function should have already ensured this).

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
        // elements).  This also ensures the elements in each cell are appropriately sorted by
        // approximate Y co-ordinate and then by X co-ordinate.

        removeOverhangingElements(rows, assessmentCell, descriptionCell, decisionDateCell);

        // Try to extract a development application from each row (some rows, such as the heading
        // row, will not actually contain a development application).

        for (let row of rows) {
            let rowApplicationNumberCell = row.find(cell => getHorizontalOverlapPercentage(cell, applicationNumberCell) > 90);
            let rowAddressCell = row.find(cell => getHorizontalOverlapPercentage(cell, addressCell) > 90);
            let rowDescriptionCell = row.find(cell => getHorizontalOverlapPercentage(cell, descriptionCell) > 90);

            let applicationNumber = rowApplicationNumberCell.elements.map(element => element.text).join("").trim();
            let address = rowAddressCell.elements.map(element => element.text).join("").replace(/\s\s+/g, " ").trim();
            let description = (rowDescriptionCell === undefined) ? "" : rowDescriptionCell.elements.map(element => element.text).join("").replace(/\s\s+/g, " ").trim();

            if (!/[0-9]+\/[0-9]+\/[0-9]/.test(applicationNumber))  // an application number must be present
                continue;

            address = formatAddress(address);
            if (address === "")  // an address must be present
                continue;

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

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read all street, street suffix, suburb and hundred information.

    readAddressInformation();

    // Retrieve the page that contains the links to the PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    
    let pdfUrls: string[] = [];
    for (let element of $("td.u6ListTD a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl);
        if (!pdfUrls.some(url => url === pdfUrl.href))  // avoid duplicates
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

    let selectedPdfUrls: string[] = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();

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
