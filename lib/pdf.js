// Extract text from an uploaded PDF buffer, optionally limited to a page range.
const pdfParse = require("pdf-parse");

async function extractText(buffer, startPage, endPage) {
  // pdf-parse can render per page; we collect pages we care about.
  const wanted = (startPage && endPage)
    ? { start: Math.max(1, startPage), end: Math.max(startPage, endPage) }
    : null;

  let pages = [];
  const options = {
    pagerender: (pageData) => {
      return pageData.getTextContent().then(tc => {
        const text = tc.items.map(i => i.str).join(" ");
        pages.push(text);
        return text;
      });
    }
  };

  const data = await pdfParse(buffer, options);
  const numPages = data.numpages || pages.length;

  let text;
  if (wanted && pages.length) {
    const slice = pages.slice(wanted.start - 1, wanted.end);
    text = slice.join("\n\n");
  } else {
    text = data.text || pages.join("\n\n");
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const wordCount = text ? text.split(/\s+/).length : 0;
  return { text, numPages, wordCount };
}

module.exports = { extractText };
