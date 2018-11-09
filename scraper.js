// Parses the development applications at the South Australian Wattle Range Council web site and
// places them in a database.
//
// Michael Bone
// 20th October 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
// All valid suburb names.
let SuburbNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
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
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.  Take care to avoid extremely tall elements (because these may otherwise
// be considered as part of all rows and effectively force the return value of this function to
// the same value, regardless of the value of startElement).
function getRowTop(elements, startElement) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y) // check for overlap
            if (getVerticalOverlapPercentage(startElement, element) > 50) // avoids extremely tall elements
                if (element.y < top)
                    top = element.y;
    return top;
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
// Calculates the square of the Euclidean distance between two elements.
function calculateDistance(element1, element2) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5) // arbitrary overlap factor of 20% (ie. ignore elements that overlap too much in the horizontal direction)
        return Number.MAX_VALUE;
    return (point2.x - point1.x) ** 2 + (point2.y - point1.y) ** 2;
}
// Determines whether there is vertical overlap between two elements.
function isVerticalOverlap(element1, element2) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}
// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).
function getVerticalOverlapPercentage(element1, element2) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
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
// Gets the element immediately to the right of the specified element (but ignores elements that
// appear after a large horizontal gap).
function getRightElement(elements, element) {
    let closestElement = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) && // ensure that there is at least some vertical overlap
            getVerticalOverlapPercentage(element, rightElement) > 50 && // avoid extremely tall elements (ensure at least 50% overlap)
            (rightElement.x > element.x + element.width) && // ensure the element actually is to the right
            (rightElement.x - (element.x + element.width) < 30) && // avoid elements that appear after a large gap (arbitrarily ensure less than a 30 pixel gap horizontally)
            calculateDistance(element, rightElement) < calculateDistance(element, closestElement)) // check if closer than any element encountered so far
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}
// Formats (and corrects) an address.
function formatAddress(address) {
    address = address.trim();
    if (address === "")
        return "";
    // Pop tokens from the end of the array until a valid suburb name is encountered (allowing
    // for a few spelling errors).
    let tokens = address.split(" ");
    let suburbName = null;
    for (let index = 1; index <= 4; index++) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index); // remove elements from the end of the array           
            break;
        }
    }
    if (suburbName === null) { // suburb name not found (or not recognised)
        console.log(`The state and post code will not be added because the suburb was not recognised: ${address}`);
        return address;
    }
    // Add the suburb name with its state and post code to the street name.
    let streetName = tokens.join(" ").trim();
    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}
// Parses the details from the elements associated with a single development application.
function parseApplicationElements(elements, startElement, applicantElement, applicationElement, proposalElement, referralsElement, informationUrl) {
    // Get the application number.
    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    let applicationNumberElements = elements
        .filter(element => element.x < applicantElement.x && element.y < startElement.y + 2 * startElement.height)
        .sort(xComparer);
    let applicationNumber = undefined;
    for (let index = 1; index <= applicationNumberElements.length; index++) {
        let text = applicationNumberElements.slice(0, index).map(element => element.text).join("").replace(/\s/g, "");
        if (/\/[0-9]{4}$/.test(text)) {
            applicationNumber = text;
            break;
        }
    }
    if (applicationNumber === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    console.log(`    Found \"${applicationNumber}\".`);
    // Get the application date element (text to the right of this constitutes the address).
    let applicationDateElement = undefined;
    let applicationDateRectangle = { x: applicationElement.x, y: 0, width: applicationElement.width, height: applicationElement.height };
    for (let element of elements) {
        applicationDateRectangle.y = element.y;
        if (getArea(element) > 0 && // ensure a valid element
            getArea(element) > 0.5 * getArea(applicationDateRectangle) && // ensure that the element is approximately the same size (within 50%) as what is expected for the date rectangle
            getArea(intersect(element, applicationDateRectangle)) > 0.75 * getArea(element)) { // determine if the element mostly overlaps (by more than 75%) the rectangle where the date is expected to appear
            applicationDateElement = element;
            break;
        }
    }
    if (applicationDateElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application date on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    // Get the received date.
    let receivedDateElement = undefined;
    let receivedDateRectangle = { x: applicationElement.x, y: 0, width: applicationElement.width, height: applicationElement.height };
    for (let element of elements) {
        receivedDateRectangle.y = element.y;
        if (getArea(element) > 0 && // ensure a valid element
            getArea(element) > 0.5 * getArea(receivedDateRectangle) && // ensure that the element is approximately the same size (within 50%) as what is expected for the date rectangle
            getArea(intersect(element, receivedDateRectangle)) > 0.75 * getArea(element) && // determine if the element mostly overlaps (by more than 75%) the rectangle where the date is expected to appear
            element.y > applicationDateElement.y + applicationDateElement.height && // ignore the application date (the recieved date appears futher down)
            moment(element.text.trim(), "D/MM/YYYY", true).isValid()) { // ensure that "Received" and "Date" text are ignored (keep searching until a valid date is found)
            receivedDateElement = element;
            break;
        }
    }
    if (receivedDateElement === undefined)
        receivedDateElement = applicationDateElement; // fallback to the application date
    let receivedDate = moment(applicationDateElement.text.trim(), "D/MM/YYYY", true);
    // Get the address (to the right of the application date element and to the left of the
    // "Proposal" column heading).  The address seems to always be a single line.
    let address = elements
        .filter(element => element.x > applicationDateElement.x + applicationDateElement.width && // the address elements must be to the right of the application date
        getVerticalOverlapPercentage(applicationDateElement, element) > 50 && // the address element must overlap vertically with the application date element
        element.x < proposalElement.x - proposalElement.height / 2) // the address element must be at least a little to the left of the "Proposal" heading text (arbitrarily use half the height)
        .sort(xComparer)
        .map(element => element.text)
        .join("");
    address = formatAddress(address); // add the state and post code to the address
    // Get the description.
    let description = "";
    if (referralsElement !== undefined) {
        let descriptionElements = elements
            .filter(element => element.x > proposalElement.x - proposalElement.height / 2 && // the description elements may start at least a little to the left to the "Proposal" heading
            element.x < referralsElement.x); // the description elements are to the left of the "Referrals/" heading
        let previousY = undefined;
        for (let descriptionElement of descriptionElements) {
            if (previousY !== undefined && descriptionElement.y > previousY + descriptionElement.height / 2) // a new line
                description += " ";
            description += descriptionElement.text;
            previousY = descriptionElement.y;
        }
    }
    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description.trim() === "") ? "No Description Provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : ""
    };
}
// Finds the start element of each development application on the current PDF page (there are
// typically many development applications on a single page and each development application
// typically begins with the text "Lodgement").
function findStartElements(elements) {
    // Examine all the elements on the page that being with "L" or "l".
    let startElements = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith("l"))) {
        // Extract up to 10 elements to the right of the element that has text starting with the
        // letter "l" (and so may be the start of the "Lodgement" text).  Join together the
        // elements to the right in an attempt to find the best match to "Lodgement".
        let rightElement = element;
        let rightElements = [];
        let matches = [];
        do {
            rightElements.push(rightElement);
            let text = rightElements.map(element => element.text).join("").replace(/\s/g, "").toLowerCase();
            if (text.length >= 10) // stop once the text is too long
                break;
            if (text.length >= 8) { // ignore until the text is close to long enough
                if (text === "lodgement")
                    matches.push({ element: rightElement, threshold: 0 });
                else if (didyoumean(text, ["Lodgement"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 1 });
                else if (didyoumean(text, ["Lodgement"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 2 });
            }
            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 10);
        // Chose the best match (if any matches were found).
        if (matches.length > 0) {
            let bestMatch = matches.reduce((previous, current) => (previous === undefined ||
                previous.threshold < current.threshold ||
                (previous.threshold === current.threshold && Math.abs(previous.text.length - "Lodgement".length) <= Math.abs(current.text.length - "Lodgement".length)) ? current : previous), undefined);
            startElements.push(bestMatch.element);
        }
    }
    // Ensure the start elements are sorted in the order that they appear on the page.
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    startElements.sort(yComparer);
    return startElements;
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
        // height or a  very narrow width.
        let lines = [];
        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] !== pdfjs.OPS.constructPath)
                continue;
            let x = operators.argsArray[index][1][1];
            let y = operators.argsArray[index][1][0];
            let width = operators.argsArray[index][1][3];
            let height = operators.argsArray[index][1][2];
            lines.push({ x: x, y: y, width: width, height: height });
            // console.log(`            Draw(e.Graphics, ${x}f, ${y}f, ${width}f, ${height}f);`);
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
        for (let point of points)
            console.log(`            DrawPoint(e.Graphics, ${point.x}f, ${point.y}f);`);
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
            if (closestRightPoint !== undefined && closestDownPoint !== undefined) {
                let cell = { elements: [], x: point.x, y: point.y, width: closestRightPoint.x - point.x, height: closestDownPoint.y - point.y };
                console.log(`            DrawRectangle(e.Graphics, ${cell.x}f, ${cell.y}f, ${cell.width}f, ${cell.height}f);`);
                cells.push(cell);
            }
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
            console.log(`            DrawText(e.Graphics, "${item.str}", ${x}f, ${y}f, ${width}f, ${height}f);`);
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
        // Find the heading cells.
        let assessmentCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "ASSESS" && contains(cell, element)));
        let vgNumberCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "VG NUMBER" && contains(cell, element)));
        let applicationNumberCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DA NUMBER" && contains(cell, element)));
        let applicantCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "APPLICANT" && contains(cell, element)));
        let ownerCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "OWNER" && contains(cell, element)));
        let builderCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "BUILDER" && contains(cell, element)));
        let addressCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "LOCATION" && contains(cell, element)));
        let descriptionCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DESCRIPTION" && contains(cell, element)));
        let decisionDateCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DECISION" && contains(cell, element)));
        let valuationCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "VALUATION" && contains(cell, element)));
        let areaCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "AREA" && contains(cell, element)));
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
        // Parse any elements that intersect more than one cell.
        for (let cell of cells) {
            if (cell.elements.some(element => !contains(cell, element))) {
                // Examine each cell that the element intersects.  In most cases determining which
                // column heading the first cell falls under will enable the text to be split and
                // so then allocated to appropriate columns.
                // let firstCell = element.cells[0];
                if (getHorizontalOverlapPercentage(cell, assessmentCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, vgNumberCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, applicationNumberCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, applicantCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, ownerCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, builderCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, addressCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, descriptionCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, decisionDateCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, valuationCell) > 90) {
                }
                else if (getHorizontalOverlapPercentage(cell, areaCell) > 90) {
                }
                else {
                }
            }
        }
        // Group the elements into rows.
        // Sort the elements by Y co-ordinate and then by X co-ordinate.
        //
        // let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        // elements.sort(elementComparer);
        // Ignore the page number (the last element on the page).  Otherwise this will end up as
        // part of a description.
        //
        // if (/[0-9]+/.test(elements[elements.length - 1].text) && Number(elements[elements.length - 1].text) < 1000)
        //     elements.pop();
        // Find the main column heading elements.
        //
        // let applicationElement = elements.find(element => element.text.trim() === "DA NUMBER");
        // let applicantElement = elements.find(element => element.text.trim() === "APPLICANT");
        // let ownerElement = elements.find(element => element.text.trim() === "OWNER");
        // let locationElement = elements.find(element => element.text.trim() === "LOCATION");
        // let descriptionElement = elements.find(element => element.text.trim() === "DESCRIPTION");
        // let decisionElement = elements.find(element => element.text.trim() === "DECISION");
        // let proposalElement = undefined;
        // let referralsElement = undefined;
        // if (applicantElement === undefined) {
        //     let elementSummary = elements.map(element => `[${element.text}]`).join("");
        //     console.log(`No development applications can be parsed from the current page because the \"Applicant\" column heading was not found.  Elements: ${elementSummary}`);
        //     continue;
        // } else if (applicationElement === undefined) {
        //     let elementSummary = elements.map(element => `[${element.text}]`).join("");
        //     console.log(`No development applications can be parsed from the current page because the \"Application Date\" column heading was not found.  Elements: ${elementSummary}`);
        //     continue;
        // } else if (proposalElement === undefined) {
        //     let elementSummary = elements.map(element => `[${element.text}]`).join("");
        //     console.log(`No development applications can be parsed from the current page because the \"Proposal\" column heading was not found.  Elements: ${elementSummary}`);
        //     continue;
        // }
        // Group the elements into sections based on where the "Lodgement" text starts (and other
        // elements the "Lodgement" elements line up with horizontally with a margin of error equal
        // to about half the height of the "Lodgement" text).
        let applicationElementGroups = [];
        let startElements = findStartElements(elements);
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height).
            let startElement = startElements[index];
            let raisedStartElement = {
                text: startElement.text,
                x: startElement.x,
                y: startElement.y - startElement.height / 2,
                width: startElement.width,
                height: startElement.height
            };
            let rowTop = getRowTop(elements, raisedStartElement);
            let nextRowTop = (index + 1 < startElements.length) ? getRowTop(elements, startElements[index + 1]) : Number.MAX_VALUE;
            // Extract all elements between the two rows.
            applicationElementGroups.push({ startElement: startElements[index], elements: elements.filter(element => element.y >= rowTop && element.y + element.height < nextRowTop) });
        }
        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).  If the same application number is encountered a
        // second time add a suffix to the application number so it is unique (and so will be
        // inserted into the database later instead of being ignored).
        //
        // for (let applicationElementGroup of applicationElementGroups) {
        //     let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, applicantElement, applicationElement, proposalElement, referralsElement, url);
        //     if (developmentApplication !== undefined) {
        //         let suffix = 0;
        //         let applicationNumber = developmentApplication.applicationNumber;
        //         while (developmentApplications
        //             .some(otherDevelopmentApplication =>
        //                 otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber &&
        //                     (otherDevelopmentApplication.address !== developmentApplication.address ||
        //                     otherDevelopmentApplication.description !== developmentApplication.description ||
        //                     otherDevelopmentApplication.receivedDate !== developmentApplication.receivedDate)))
        //             developmentApplication.applicationNumber = `${applicationNumber} (${++suffix})`;  // add a unique suffix
        //         developmentApplications.push(developmentApplication);
        //     }
        // }
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
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Read the files containing all possible suburb names.
    SuburbNames = {};
    // for (let suburb of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n"))
    //     SuburbNames[suburb.split(",")[0]] = suburb.split(",")[1];
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
    let selectedPdfUrls = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();
    console.log("Testing PDF.");
    selectedPdfUrls = ["https://www.wattlerange.sa.gov.au/webdata/resources/files/Stats%20March%2018.pdf"];
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0dBQWdHO0FBQ2hHLDZCQUE2QjtBQUM3QixFQUFFO0FBQ0YsZUFBZTtBQUNmLG9CQUFvQjtBQUVwQixZQUFZLENBQUM7O0FBR2IsbUNBQW1DO0FBQ25DLGtEQUFrRDtBQUNsRCxtQ0FBbUM7QUFDbkMsaUNBQWlDO0FBQ2pDLGlDQUFpQztBQUNqQyxvQ0FBb0M7QUFDcEMsMENBQTBDO0FBRTFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUVsQixNQUFNLDBCQUEwQixHQUFHLG9EQUFvRCxDQUFDO0FBQ3hGLE1BQU0sVUFBVSxHQUFHLHNDQUFzQyxDQUFDO0FBSTFELDBCQUEwQjtBQUUxQixJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFFdkIsOEJBQThCO0FBRTlCLEtBQUssVUFBVSxrQkFBa0I7SUFDN0IsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbkQsUUFBUSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUU7WUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQyw4TEFBOEwsQ0FBQyxDQUFDO1lBQzdNLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN0QixDQUFDLENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELDhEQUE4RDtBQUU5RCxLQUFLLFVBQVUsU0FBUyxDQUFDLFFBQVEsRUFBRSxzQkFBc0I7SUFDckQsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFlBQVksR0FBRyxRQUFRLENBQUMsT0FBTyxDQUFDLDJEQUEyRCxDQUFDLENBQUM7UUFDakcsWUFBWSxDQUFDLEdBQUcsQ0FBQztZQUNiLHNCQUFzQixDQUFDLGlCQUFpQjtZQUN4QyxzQkFBc0IsQ0FBQyxPQUFPO1lBQzlCLHNCQUFzQixDQUFDLFdBQVc7WUFDbEMsc0JBQXNCLENBQUMsY0FBYztZQUNyQyxzQkFBc0IsQ0FBQyxVQUFVO1lBQ2pDLHNCQUFzQixDQUFDLFVBQVU7WUFDakMsc0JBQXNCLENBQUMsWUFBWTtTQUN0QyxFQUFFLFVBQVMsS0FBSyxFQUFFLEdBQUc7WUFDbEIsSUFBSSxLQUFLLEVBQUU7Z0JBQ1AsT0FBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQztnQkFDckIsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO2FBQ2pCO2lCQUFNO2dCQUNILElBQUksSUFBSSxDQUFDLE9BQU8sR0FBRyxDQUFDO29CQUNoQixPQUFPLENBQUMsR0FBRyxDQUFDLCtCQUErQixzQkFBc0IsQ0FBQyxpQkFBaUIscUJBQXFCLHNCQUFzQixDQUFDLE9BQU8scUJBQXFCLHNCQUFzQixDQUFDLFdBQVcsMEJBQTBCLHNCQUFzQixDQUFDLFlBQVksdUJBQXVCLENBQUMsQ0FBQzs7b0JBRW5SLE9BQU8sQ0FBQyxHQUFHLENBQUMsOEJBQThCLHNCQUFzQixDQUFDLGlCQUFpQixxQkFBcUIsc0JBQXNCLENBQUMsT0FBTyxxQkFBcUIsc0JBQXNCLENBQUMsV0FBVywwQkFBMEIsc0JBQXNCLENBQUMsWUFBWSxvREFBb0QsQ0FBQyxDQUFDO2dCQUNuVCxZQUFZLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBRSxxQkFBcUI7Z0JBQy9DLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQzthQUNoQjtRQUNMLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDO0FBOEJELDhGQUE4RjtBQUM5RixrR0FBa0c7QUFDbEcsK0ZBQStGO0FBQy9GLDREQUE0RDtBQUU1RCxTQUFTLFNBQVMsQ0FBQyxRQUFtQixFQUFFLFlBQXFCO0lBQ3pELElBQUksR0FBRyxHQUFHLFlBQVksQ0FBQyxDQUFDLENBQUM7SUFDekIsS0FBSyxJQUFJLE9BQU8sSUFBSSxRQUFRO1FBQ3hCLElBQUksT0FBTyxDQUFDLENBQUMsR0FBRyxZQUFZLENBQUMsQ0FBQyxHQUFHLFlBQVksQ0FBQyxNQUFNLElBQUksT0FBTyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsTUFBTSxHQUFHLFlBQVksQ0FBQyxDQUFDLEVBQUcsb0JBQW9CO1lBQ3RILElBQUksNEJBQTRCLENBQUMsWUFBWSxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsRUFBRyxpQ0FBaUM7Z0JBQzVGLElBQUksT0FBTyxDQUFDLENBQUMsR0FBRyxHQUFHO29CQUNmLEdBQUcsR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ2hDLE9BQU8sR0FBRyxDQUFDO0FBQ2YsQ0FBQztBQUVELG9GQUFvRjtBQUVwRixTQUFTLFNBQVMsQ0FBQyxVQUFxQixFQUFFLFVBQXFCO0lBQzNELElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUMsRUFBRSxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDOUMsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxFQUFFLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5QyxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEdBQUcsVUFBVSxDQUFDLEtBQUssRUFBRSxVQUFVLENBQUMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNwRixJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEdBQUcsVUFBVSxDQUFDLE1BQU0sRUFBRSxVQUFVLENBQUMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN0RixJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUU7UUFDcEIsT0FBTyxFQUFFLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsRUFBRSxHQUFHLEVBQUUsRUFBRSxNQUFNLEVBQUUsRUFBRSxHQUFHLEVBQUUsRUFBRSxDQUFDOztRQUV6RCxPQUFPLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxDQUFDO0FBQ25ELENBQUM7QUFFRCxnRkFBZ0Y7QUFFaEYsU0FBUyxRQUFRLENBQUMsa0JBQTZCLEVBQUUsa0JBQTZCO0lBQzFFLE9BQU8sa0JBQWtCLENBQUMsQ0FBQyxJQUFJLGtCQUFrQixDQUFDLENBQUM7UUFDL0Msa0JBQWtCLENBQUMsQ0FBQyxJQUFJLGtCQUFrQixDQUFDLENBQUM7UUFDNUMsa0JBQWtCLENBQUMsQ0FBQyxHQUFHLGtCQUFrQixDQUFDLEtBQUssSUFBSSxrQkFBa0IsQ0FBQyxDQUFDLEdBQUcsa0JBQWtCLENBQUMsS0FBSztRQUNsRyxrQkFBa0IsQ0FBQyxDQUFDLEdBQUcsa0JBQWtCLENBQUMsTUFBTSxJQUFJLGtCQUFrQixDQUFDLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxNQUFNLENBQUM7QUFDN0csQ0FBQztBQUVELHNDQUFzQztBQUV0QyxTQUFTLE9BQU8sQ0FBQyxTQUFvQjtJQUNqQyxPQUFPLFNBQVMsQ0FBQyxLQUFLLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQztBQUM5QyxDQUFDO0FBRUQsd0VBQXdFO0FBRXhFLFNBQVMsaUJBQWlCLENBQUMsUUFBaUIsRUFBRSxRQUFpQjtJQUMzRCxJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztJQUNyRixJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7SUFDcEUsSUFBSSxNQUFNLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLEtBQUssR0FBRyxDQUFDLEVBQUcsMEdBQTBHO1FBQ3JKLE9BQU8sTUFBTSxDQUFDLFNBQVMsQ0FBQztJQUM1QixPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ25FLENBQUM7QUFFRCxxRUFBcUU7QUFFckUsU0FBUyxpQkFBaUIsQ0FBQyxRQUFpQixFQUFFLFFBQWlCO0lBQzNELE9BQU8sUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLElBQUksUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDbEcsQ0FBQztBQUVELGlHQUFpRztBQUNqRyw2RkFBNkY7QUFDN0YsMkJBQTJCO0FBRTNCLFNBQVMsNEJBQTRCLENBQUMsUUFBaUIsRUFBRSxRQUFpQjtJQUN0RSxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzFDLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQzlFLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUNqRSxDQUFDO0FBRUQsK0ZBQStGO0FBQy9GLHVCQUF1QjtBQUV2QixTQUFTLDhCQUE4QixDQUFDLFVBQXFCLEVBQUUsVUFBcUI7SUFDaEYsSUFBSSxVQUFVLEtBQUssU0FBUyxJQUFJLFVBQVUsS0FBSyxTQUFTO1FBQ3BELE9BQU8sQ0FBQyxDQUFDO0lBRWIsSUFBSSxPQUFPLEdBQUcsVUFBVSxDQUFDLENBQUMsQ0FBQztJQUMzQixJQUFJLEtBQUssR0FBRyxVQUFVLENBQUMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUM7SUFFNUMsSUFBSSxPQUFPLEdBQUcsVUFBVSxDQUFDLENBQUMsQ0FBQztJQUMzQixJQUFJLEtBQUssR0FBRyxVQUFVLENBQUMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUM7SUFFNUMsSUFBSSxPQUFPLElBQUksS0FBSyxJQUFJLEtBQUssSUFBSSxPQUFPLElBQUksVUFBVSxDQUFDLEtBQUssS0FBSyxDQUFDLElBQUksVUFBVSxDQUFDLEtBQUssS0FBSyxDQUFDO1FBQ3hGLE9BQU8sQ0FBQyxDQUFDO0lBRWIsSUFBSSxpQkFBaUIsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztJQUM1RSxJQUFJLFVBQVUsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztJQUVyRSxPQUFPLENBQUMsaUJBQWlCLEdBQUcsR0FBRyxDQUFDLEdBQUcsVUFBVSxDQUFDO0FBQ2xELENBQUM7QUFFRCxnR0FBZ0c7QUFDaEcsd0NBQXdDO0FBRXhDLFNBQVMsZUFBZSxDQUFDLFFBQW1CLEVBQUUsT0FBZ0I7SUFDMUQsSUFBSSxjQUFjLEdBQVksRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxNQUFNLENBQUMsU0FBUyxFQUFFLENBQUMsRUFBRSxNQUFNLENBQUMsU0FBUyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQ2pILEtBQUssSUFBSSxZQUFZLElBQUksUUFBUTtRQUM3QixJQUFJLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxZQUFZLENBQUMsSUFBSyxzREFBc0Q7WUFDbkcsNEJBQTRCLENBQUMsT0FBTyxFQUFFLFlBQVksQ0FBQyxHQUFHLEVBQUUsSUFBSyw4REFBOEQ7WUFDM0gsQ0FBQyxZQUFZLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFLLDhDQUE4QztZQUMvRixDQUFDLFlBQVksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUMsSUFBSywwR0FBMEc7WUFDbEssaUJBQWlCLENBQUMsT0FBTyxFQUFFLFlBQVksQ0FBQyxHQUFHLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxjQUFjLENBQUMsRUFBRyxzREFBc0Q7WUFDOUksY0FBYyxHQUFHLFlBQVksQ0FBQztJQUN0QyxPQUFPLENBQUMsY0FBYyxDQUFDLElBQUksS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUM7QUFDNUUsQ0FBQztBQUVELHFDQUFxQztBQUVyQyxTQUFTLGFBQWEsQ0FBQyxPQUFlO0lBQ2xDLE9BQU8sR0FBRyxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDekIsSUFBSSxPQUFPLEtBQUssRUFBRTtRQUNkLE9BQU8sRUFBRSxDQUFDO0lBRWQsMEZBQTBGO0lBQzFGLDhCQUE4QjtJQUU5QixJQUFJLE1BQU0sR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWhDLElBQUksVUFBVSxHQUFHLElBQUksQ0FBQztJQUN0QixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLElBQUksQ0FBQyxFQUFFLEtBQUssRUFBRSxFQUFFO1FBQ3JDLElBQUksZUFBZSxHQUFHLFVBQVUsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLEVBQUUsRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxxQkFBcUIsRUFBRSxhQUFhLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7UUFDdk4sSUFBSSxlQUFlLEtBQUssSUFBSSxFQUFFO1lBQzFCLFVBQVUsR0FBRyxXQUFXLENBQUMsZUFBZSxDQUFDLENBQUM7WUFDMUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFFLHVEQUF1RDtZQUN0RixNQUFNO1NBQ1Q7S0FDSjtJQUVELElBQUksVUFBVSxLQUFLLElBQUksRUFBRSxFQUFHLDRDQUE0QztRQUNwRSxPQUFPLENBQUMsR0FBRyxDQUFDLG9GQUFvRixPQUFPLEVBQUUsQ0FBQyxDQUFDO1FBQzNHLE9BQU8sT0FBTyxDQUFDO0tBQ2xCO0lBRUQsdUVBQXVFO0lBRXZFLElBQUksVUFBVSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDekMsT0FBTyxDQUFDLFVBQVUsR0FBRyxDQUFDLENBQUMsVUFBVSxLQUFLLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLFVBQVUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQ2hGLENBQUM7QUFFRCx5RkFBeUY7QUFFekYsU0FBUyx3QkFBd0IsQ0FBQyxRQUFtQixFQUFFLFlBQXFCLEVBQUUsZ0JBQXlCLEVBQUUsa0JBQTJCLEVBQUUsZUFBd0IsRUFBRSxnQkFBeUIsRUFBRSxjQUFzQjtJQUM3TSw4QkFBOEI7SUFFOUIsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ25FLElBQUkseUJBQXlCLEdBQUcsUUFBUTtTQUNuQyxNQUFNLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLENBQUMsSUFBSSxPQUFPLENBQUMsQ0FBQyxHQUFHLFlBQVksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLFlBQVksQ0FBQyxNQUFNLENBQUM7U0FDekcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBRXJCLElBQUksaUJBQWlCLEdBQUcsU0FBUyxDQUFDO0lBQ2xDLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssSUFBSSx5QkFBeUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEVBQUU7UUFDcEUsSUFBSSxJQUFJLEdBQUcseUJBQXlCLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDOUcsSUFBSSxhQUFhLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFO1lBQzFCLGlCQUFpQixHQUFHLElBQUksQ0FBQztZQUN6QixNQUFNO1NBQ1Q7S0FDSjtJQUNELElBQUksaUJBQWlCLEtBQUssU0FBUyxFQUFFO1FBQ2pDLElBQUksY0FBYyxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMzRSxPQUFPLENBQUMsR0FBRyxDQUFDLDJKQUEySixjQUFjLEVBQUUsQ0FBQyxDQUFDO1FBQ3pMLE9BQU8sU0FBUyxDQUFDO0tBQ3BCO0lBQ0QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUFlLGlCQUFpQixLQUFLLENBQUMsQ0FBQztJQUVuRCx3RkFBd0Y7SUFFeEYsSUFBSSxzQkFBc0IsR0FBWSxTQUFTLENBQUM7SUFDaEQsSUFBSSx3QkFBd0IsR0FBZSxFQUFFLENBQUMsRUFBRSxrQkFBa0IsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsa0JBQWtCLENBQUMsS0FBSyxFQUFFLE1BQU0sRUFBRyxrQkFBa0IsQ0FBQyxNQUFNLEVBQUUsQ0FBQztJQUNsSixLQUFLLElBQUksT0FBTyxJQUFJLFFBQVEsRUFBRTtRQUMxQix3QkFBd0IsQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQztRQUN2QyxJQUFJLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUsseUJBQXlCO1lBQ2xELE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxHQUFHLEdBQUcsT0FBTyxDQUFDLHdCQUF3QixDQUFDLElBQUssaUhBQWlIO1lBQ2hMLE9BQU8sQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLHdCQUF3QixDQUFDLENBQUMsR0FBRyxJQUFJLEdBQUcsT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEVBQUcsaUhBQWlIO1lBQ3JNLHNCQUFzQixHQUFHLE9BQU8sQ0FBQztZQUNqQyxNQUFNO1NBQ1Q7S0FDSjtJQUNELElBQUksc0JBQXNCLEtBQUssU0FBUyxFQUFFO1FBQ3RDLElBQUksY0FBYyxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMzRSxPQUFPLENBQUMsR0FBRyxDQUFDLHlKQUF5SixjQUFjLEVBQUUsQ0FBQyxDQUFDO1FBQ3ZMLE9BQU8sU0FBUyxDQUFDO0tBQ3BCO0lBRUQseUJBQXlCO0lBRXpCLElBQUksbUJBQW1CLEdBQVksU0FBUyxDQUFDO0lBQzdDLElBQUkscUJBQXFCLEdBQWUsRUFBRSxDQUFDLEVBQUUsa0JBQWtCLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLGtCQUFrQixDQUFDLEtBQUssRUFBRSxNQUFNLEVBQUcsa0JBQWtCLENBQUMsTUFBTSxFQUFFLENBQUM7SUFDL0ksS0FBSyxJQUFJLE9BQU8sSUFBSSxRQUFRLEVBQUU7UUFDMUIscUJBQXFCLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFDcEMsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFLLHlCQUF5QjtZQUNsRCxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsR0FBRyxHQUFHLE9BQU8sQ0FBQyxxQkFBcUIsQ0FBQyxJQUFLLGlIQUFpSDtZQUM3SyxPQUFPLENBQUMsU0FBUyxDQUFDLE9BQU8sRUFBRSxxQkFBcUIsQ0FBQyxDQUFDLEdBQUcsSUFBSSxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSyxpSEFBaUg7WUFDbE0sT0FBTyxDQUFDLENBQUMsR0FBRyxzQkFBc0IsQ0FBQyxDQUFDLEdBQUcsc0JBQXNCLENBQUMsTUFBTSxJQUFLLHNFQUFzRTtZQUMvSSxNQUFNLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxXQUFXLEVBQUUsSUFBSSxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsRUFBRyxrR0FBa0c7WUFDL0osbUJBQW1CLEdBQUcsT0FBTyxDQUFDO1lBQzlCLE1BQU07U0FDVDtLQUNKO0lBRUQsSUFBSSxtQkFBbUIsS0FBSyxTQUFTO1FBQ2pDLG1CQUFtQixHQUFHLHNCQUFzQixDQUFDLENBQUUsbUNBQW1DO0lBRXRGLElBQUksWUFBWSxHQUFHLE1BQU0sQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEVBQUUsV0FBVyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBRWpGLHVGQUF1RjtJQUN2Riw2RUFBNkU7SUFFN0UsSUFBSSxPQUFPLEdBQUcsUUFBUTtTQUNqQixNQUFNLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FDZCxPQUFPLENBQUMsQ0FBQyxHQUFHLHNCQUFzQixDQUFDLENBQUMsR0FBRyxzQkFBc0IsQ0FBQyxLQUFLLElBQUssb0VBQW9FO1FBQzVJLDRCQUE0QixDQUFDLHNCQUFzQixFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsSUFBSyxnRkFBZ0Y7UUFDdkosT0FBTyxDQUFDLENBQUMsR0FBRyxlQUFlLENBQUMsQ0FBQyxHQUFHLGVBQWUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUUsNkhBQTZIO1NBQzdMLElBQUksQ0FBQyxTQUFTLENBQUM7U0FDZixHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1NBQzVCLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUVkLE9BQU8sR0FBRyxhQUFhLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBRSw2Q0FBNkM7SUFFaEYsdUJBQXVCO0lBRXZCLElBQUksV0FBVyxHQUFHLEVBQUUsQ0FBQztJQUVyQixJQUFJLGdCQUFnQixLQUFLLFNBQVMsRUFBRTtRQUNoQyxJQUFJLG1CQUFtQixHQUFHLFFBQVE7YUFDN0IsTUFBTSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQ2QsT0FBTyxDQUFDLENBQUMsR0FBRyxlQUFlLENBQUMsQ0FBQyxHQUFHLGVBQWUsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFLLDZGQUE2RjtZQUM1SixPQUFPLENBQUMsQ0FBQyxHQUFHLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUUsdUVBQXVFO1FBRWpILElBQUksU0FBUyxHQUFHLFNBQVMsQ0FBQztRQUMxQixLQUFLLElBQUksa0JBQWtCLElBQUksbUJBQW1CLEVBQUU7WUFDaEQsSUFBSSxTQUFTLEtBQUssU0FBUyxJQUFJLGtCQUFrQixDQUFDLENBQUMsR0FBRyxTQUFTLEdBQUcsa0JBQWtCLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRyxhQUFhO2dCQUMzRyxXQUFXLElBQUksR0FBRyxDQUFDO1lBQ3ZCLFdBQVcsSUFBSSxrQkFBa0IsQ0FBQyxJQUFJLENBQUM7WUFDdkMsU0FBUyxHQUFHLGtCQUFrQixDQUFDLENBQUMsQ0FBQztTQUNwQztLQUNKO0lBRUQsT0FBTztRQUNILGlCQUFpQixFQUFFLGlCQUFpQjtRQUNwQyxPQUFPLEVBQUUsT0FBTztRQUNoQixXQUFXLEVBQUUsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMseUJBQXlCLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQztRQUNwRixjQUFjLEVBQUUsY0FBYztRQUM5QixVQUFVLEVBQUUsVUFBVTtRQUN0QixVQUFVLEVBQUUsTUFBTSxFQUFFLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQztRQUN6QyxZQUFZLEVBQUUsQ0FBQyxZQUFZLEtBQUssU0FBUyxJQUFJLFlBQVksQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFO0tBQ2hILENBQUM7QUFDTixDQUFDO0FBRUQsNkZBQTZGO0FBQzdGLDRGQUE0RjtBQUM1RiwrQ0FBK0M7QUFFL0MsU0FBUyxpQkFBaUIsQ0FBQyxRQUFtQjtJQUMxQyxtRUFBbUU7SUFFbkUsSUFBSSxhQUFhLEdBQWMsRUFBRSxDQUFDO0lBQ2xDLEtBQUssSUFBSSxPQUFPLElBQUksUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUU7UUFDL0Ysd0ZBQXdGO1FBQ3hGLG1GQUFtRjtRQUNuRiw2RUFBNkU7UUFFN0UsSUFBSSxZQUFZLEdBQUcsT0FBTyxDQUFDO1FBQzNCLElBQUksYUFBYSxHQUFjLEVBQUUsQ0FBQztRQUNsQyxJQUFJLE9BQU8sR0FBRyxFQUFFLENBQUM7UUFFakIsR0FBRztZQUNDLGFBQWEsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7WUFFakMsSUFBSSxJQUFJLEdBQUcsYUFBYSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNoRyxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksRUFBRSxFQUFHLGlDQUFpQztnQkFDckQsTUFBTTtZQUNWLElBQUksSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLEVBQUUsRUFBRyxnREFBZ0Q7Z0JBQ3JFLElBQUksSUFBSSxLQUFLLFdBQVc7b0JBQ3BCLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxPQUFPLEVBQUUsWUFBWSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO3FCQUNyRCxJQUFJLFVBQVUsQ0FBQyxJQUFJLEVBQUUsQ0FBRSxXQUFXLENBQUUsRUFBRSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLHFCQUFxQixFQUFFLGFBQWEsRUFBRSxlQUFlLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsS0FBSyxJQUFJO29CQUMzSyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsT0FBTyxFQUFFLFlBQVksRUFBRSxTQUFTLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQztxQkFDckQsSUFBSSxVQUFVLENBQUMsSUFBSSxFQUFFLENBQUUsV0FBVyxDQUFFLEVBQUUsRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxxQkFBcUIsRUFBRSxhQUFhLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLEtBQUssSUFBSTtvQkFDM0ssT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7YUFDN0Q7WUFFRCxZQUFZLEdBQUcsZUFBZSxDQUFDLFFBQVEsRUFBRSxZQUFZLENBQUMsQ0FBQztTQUMxRCxRQUFRLFlBQVksS0FBSyxTQUFTLElBQUksYUFBYSxDQUFDLE1BQU0sR0FBRyxFQUFFLEVBQUU7UUFFbEUsb0RBQW9EO1FBRXBELElBQUksT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7WUFDcEIsSUFBSSxTQUFTLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsRUFBRSxDQUNqRCxDQUFDLFFBQVEsS0FBSyxTQUFTO2dCQUN2QixRQUFRLENBQUMsU0FBUyxHQUFHLE9BQU8sQ0FBQyxTQUFTO2dCQUN0QyxDQUFDLFFBQVEsQ0FBQyxTQUFTLEtBQUssT0FBTyxDQUFDLFNBQVMsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQzlMLGFBQWEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1NBQ3pDO0tBQ0o7SUFFRCxrRkFBa0Y7SUFFbEYsSUFBSSxTQUFTLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ25FLGFBQWEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDOUIsT0FBTyxhQUFhLENBQUM7QUFDekIsQ0FBQztBQUVELHlCQUF5QjtBQUV6QixLQUFLLFVBQVUsUUFBUSxDQUFDLEdBQVc7SUFDL0IsSUFBSSx1QkFBdUIsR0FBRyxFQUFFLENBQUM7SUFFakMsZ0JBQWdCO0lBRWhCLElBQUksTUFBTSxHQUFHLE1BQU0sT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUM7SUFDekYsTUFBTSxLQUFLLENBQUMsSUFBSSxHQUFHLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUM7SUFFM0Msc0VBQXNFO0lBRXRFLElBQUksR0FBRyxHQUFHLE1BQU0sS0FBSyxDQUFDLFdBQVcsQ0FBQyxFQUFFLElBQUksRUFBRSxNQUFNLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUMvRixLQUFLLElBQUksU0FBUyxHQUFHLENBQUMsRUFBRSxTQUFTLEdBQUcsR0FBRyxDQUFDLFFBQVEsRUFBRSxTQUFTLEVBQUUsRUFBRTtRQUMzRCxPQUFPLENBQUMsR0FBRyxDQUFDLDhDQUE4QyxTQUFTLEdBQUcsQ0FBQyxPQUFPLEdBQUcsQ0FBQyxRQUFRLEdBQUcsQ0FBQyxDQUFDO1FBQy9GLElBQUksSUFBSSxHQUFHLE1BQU0sR0FBRyxDQUFDLE9BQU8sQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFFNUMsMEVBQTBFO1FBRTFFLElBQUksUUFBUSxHQUFHLE1BQU0sSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMzQyxJQUFJLFdBQVcsR0FBRyxNQUFNLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztRQUM5QyxJQUFJLFNBQVMsR0FBRyxNQUFNLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztRQUU3Qyx5RkFBeUY7UUFDekYsa0NBQWtDO1FBRWxDLElBQUksS0FBSyxHQUFnQixFQUFFLENBQUM7UUFFNUIsS0FBSyxJQUFJLEtBQUssR0FBRyxDQUFDLEVBQUUsS0FBSyxHQUFHLFNBQVMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEtBQUssRUFBRSxFQUFFO1lBQzNELElBQUksU0FBUyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxLQUFLLENBQUMsR0FBRyxDQUFDLGFBQWE7Z0JBQ3BELFNBQVM7WUFDYixJQUFJLENBQUMsR0FBRyxTQUFTLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3pDLElBQUksQ0FBQyxHQUFHLFNBQVMsQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDekMsSUFBSSxLQUFLLEdBQUcsU0FBUyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUM3QyxJQUFJLE1BQU0sR0FBRyxTQUFTLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBRTlDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFDLENBQUMsQ0FBQztZQUV2RCxxRkFBcUY7U0FDeEY7UUFFRCwyQ0FBMkM7UUFFM0MsSUFBSSxNQUFNLEdBQVksRUFBRSxDQUFDO1FBRXpCLEtBQUssSUFBSSxJQUFJLElBQUksS0FBSyxFQUFFO1lBQ3BCLG9GQUFvRjtZQUNwRix5RUFBeUU7WUFFekUsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksSUFBSSxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUM7Z0JBQ3JILFNBQVM7WUFFYixJQUFJLFVBQVUsR0FBVSxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDakQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ3hGLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7WUFFNUIsSUFBSSxRQUFRLEdBQVUsU0FBUyxDQUFDO1lBQ2hDLElBQUksSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLEVBQUcsa0JBQWtCO2dCQUNyQyxRQUFRLEdBQUcsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUM7aUJBQy9DLGdCQUFnQjtnQkFDbEIsUUFBUSxHQUFHLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBRXRELElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNwRixNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1NBQzdCO1FBRUQsS0FBSyxJQUFJLEtBQUssSUFBSSxNQUFNO1lBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMscUNBQXFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7UUFFaEYsK0NBQStDO1FBRS9DLElBQUksS0FBSyxHQUFXLEVBQUUsQ0FBQztRQUN2QixLQUFLLElBQUksS0FBSyxJQUFJLE1BQU0sRUFBRTtZQUN0QixrRkFBa0Y7WUFDbEYseUNBQXlDO1lBRXpDLElBQUksaUJBQWlCLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FDakMsQ0FBQyxDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksT0FBTyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxLQUFLLFNBQVMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQ3BMLFNBQVMsQ0FBQyxDQUFDO1lBRWYsOEVBQThFO1lBQzlFLHlDQUF5QztZQUV6QyxJQUFJLGdCQUFnQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQ2hDLENBQUMsQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLEdBQUcsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsS0FBSyxTQUFTLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUNwTCxTQUFTLENBQUMsQ0FBQztZQUVmLCtDQUErQztZQUUvQyxJQUFJLGlCQUFpQixLQUFLLFNBQVMsSUFBSSxnQkFBZ0IsS0FBSyxTQUFTLEVBQUU7Z0JBQ25FLElBQUksSUFBSSxHQUFTLEVBQUUsUUFBUSxFQUFFLEVBQUUsRUFBRSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsaUJBQWlCLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ3RJLE9BQU8sQ0FBQyxHQUFHLENBQUMseUNBQXlDLElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxNQUFNLElBQUksQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDO2dCQUMvRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2FBQ3BCO1NBQ0o7UUFFRCx5RUFBeUU7UUFFekUsSUFBSSxZQUFZLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM3SCxLQUFLLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBRXpCLDhCQUE4QjtRQUU5QixJQUFJLFFBQVEsR0FBYyxXQUFXLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNuRCxJQUFJLFNBQVMsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztZQUV6RSxtRkFBbUY7WUFDbkYsb0ZBQW9GO1lBQ3BGLG1GQUFtRjtZQUNuRixpQ0FBaUM7WUFFakMsSUFBSSxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsR0FBRyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsU0FBUyxDQUFDLENBQUMsQ0FBQyxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBRTVGLElBQUksQ0FBQyxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNyQixJQUFJLENBQUMsR0FBRyxTQUFTLENBQUMsQ0FBQyxDQUFDLEdBQUcsZ0JBQWdCLENBQUM7WUFDeEMsSUFBSSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQztZQUN2QixJQUFJLE1BQU0sR0FBRyxnQkFBZ0IsQ0FBQztZQUMxQyxPQUFPLENBQUMsR0FBRyxDQUFDLHFDQUFxQyxJQUFJLENBQUMsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLE1BQU0sS0FBSyxNQUFNLE1BQU0sS0FBSyxDQUFDLENBQUM7WUFFekYsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsQ0FBQztRQUN4RSxDQUFDLENBQUMsQ0FBQztRQUVILGlGQUFpRjtRQUVqRixJQUFJLGVBQWUsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2hJLFFBQVEsQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLENBQUM7UUFFL0IsbUZBQW1GO1FBQ25GLG9GQUFvRjtRQUNwRixrRkFBa0Y7UUFDbEYsNEVBQTRFO1FBRTVFLEtBQUssSUFBSSxPQUFPLElBQUksUUFBUSxFQUFFO1lBQzFCLElBQUksU0FBUyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUUsb0VBQW9FO1lBQ2hKLElBQUksU0FBUyxLQUFLLFNBQVM7Z0JBQ3ZCLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1NBQ3hDO1FBRUQsNkJBQTZCO1FBRTdCLElBQUksSUFBSSxHQUFrQixFQUFFLENBQUM7UUFFN0IsS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLEVBQUU7WUFDcEIsSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBRSxrQ0FBa0M7WUFDaEcsSUFBSSxHQUFHLEtBQUssU0FBUztnQkFDakIsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFFLElBQUksQ0FBRSxDQUFDLENBQUMsQ0FBRSxrQkFBa0I7O2dCQUV4QyxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUUseUJBQXlCO1NBQ2pEO1FBRUQsMEJBQTBCO1FBRTFCLElBQUksY0FBYyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssUUFBUSxJQUFJLFFBQVEsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3BJLElBQUksWUFBWSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssV0FBVyxJQUFJLFFBQVEsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3JJLElBQUkscUJBQXFCLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxXQUFXLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDOUksSUFBSSxhQUFhLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxXQUFXLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDdEksSUFBSSxTQUFTLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxPQUFPLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDOUgsSUFBSSxXQUFXLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxTQUFTLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEksSUFBSSxXQUFXLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxVQUFVLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkksSUFBSSxlQUFlLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxhQUFhLElBQUksUUFBUSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDMUksSUFBSSxnQkFBZ0IsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxLQUFLLFVBQVUsSUFBSSxRQUFRLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUN4SSxJQUFJLGFBQWEsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLFFB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