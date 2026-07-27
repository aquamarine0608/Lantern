/* Generates small valid EPUB 3 files for the e2e suite. */
const { zipSync, strToU8 } = require("fflate");

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const DEFAULT_CHAPTERS = [
  {
    title: "Chapter One",
    paras: [
      "The first sentence opens the book. A second sentence follows it. The third sentence ends this paragraph.",
      "A new paragraph starts here. It also holds two sentences.",
    ],
  },
  { title: "Chapter Two", paras: ["Chapter two begins with this line. Another thought continues it."] },
  {
    title: "Chapter Three",
    paras: ["The final chapter starts now. It rolls onward briefly. The story concludes with this very sentence."],
  },
];

const xhtml = (title, paras, divs = false) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body>${divs
  ? `<div class="chapter"><div class="heading">${title}</div>\n${paras.map((p) => `<div class="para">${p}</div>`).join("\n")}</div>`
  : `<h2>${title}</h2>\n${paras.map((p) => `<p>${p}</p>`).join("\n")}`}
</body></html>`;

function makeEpub({ title = "The Test Book", author = "Ada Author", creators, chapters = DEFAULT_CHAPTERS, cover = true, divs = false, encryption, subEntries = false, orphanItem = false } = {}) {
  const files = {};
  const manifest = [];
  const spine = [];
  chapters.forEach((c, i) => {
    files[`OEBPS/ch${i + 1}.xhtml`] = strToU8(xhtml(c.title, c.paras, divs));
    manifest.push(`<item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i + 1}"/>`);
  });
  /* A malformed package document: one manifest <item> with no id (spec-required)
     and one spine <itemref> with no idref (also spec-required). Both getAttribute
     calls return null, so a Map keyed by the raw attribute makes them collide and
     the unreferenced file resolves as a real chapter. */
  if (orphanItem) {
    files["OEBPS/secret.xhtml"] = strToU8(xhtml("Secret", ["This file is not in the reading order at all."]));
    manifest.push('<item href="secret.xhtml" media-type="application/xhtml+xml"/>');
    spine.push("<itemref/>");
  }
  if (encryption) {
    files["META-INF/encryption.xml"] = strToU8(`<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${encryption}"/></enc:CipherData></enc:EncryptedData>
</encryption>`);
  }

  files["OEBPS/nav.xhtml"] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head><body>
<nav epub:type="toc"><ol>
${chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${c.title}</a>${subEntries
    ? `<ol><li><a href="ch${i + 1}.xhtml#sec1">${c.title} — Section 1</a></li><li><a href="ch${i + 1}.xhtml#sec2">${c.title} — Section 2</a></li></ol>`
    : ""}</li>`).join("\n")}
</ol></nav></body></html>`);

  if (cover) files["OEBPS/cover.png"] = new Uint8Array(PNG_1x1);

  files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">lantern-test-book</dc:identifier>
    <dc:title>${title}</dc:title>
    ${(creators || [author]).map((c) => `<dc:creator>${c}</dc:creator>`).join("\n    ")}
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${cover ? '<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>' : ""}
  </manifest>
  <spine>${spine.join("")}</spine>
</package>`);

  const zip = zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    ...files,
  });
  return Buffer.from(zip);
}

/* An EPUB 2 fixture with the messy real-world traits: NCX-only toc (labels differ
   from headings), <meta name="cover"> instead of the EPUB3 property, chapters in a
   subdirectory, a percent-encoded href, and a cover reached via "../". */
function makeEpub2({ title = "An Older Book", author = "Old Author" } = {}) {
  const chapters = DEFAULT_CHAPTERS;
  const ncxLabels = ["Part I", "Part II", "Part III"];
  const hrefs = ["text/ch%201.xhtml", "text/ch2.xhtml", "text/ch3.xhtml"];
  const paths = ["OEBPS/text/ch 1.xhtml", "OEBPS/text/ch2.xhtml", "OEBPS/text/ch3.xhtml"];
  const files = {};
  chapters.forEach((c, i) => { files[paths[i]] = strToU8(xhtml(c.title, c.paras)); });
  files["IMAGES/cover.png"] = new Uint8Array(PNG_1x1);
  files["OEBPS/toc.ncx"] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head/><docTitle><text>${title}</text></docTitle>
  <navMap>
${chapters.map((c, i) => `    <navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${ncxLabels[i]}</text></navLabel><content src="${hrefs[i]}"/></navPoint>`).join("\n")}
  </navMap>
</ncx>`);
  files["OEBPS/content.opf"] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="uid">lantern-test-epub2</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator opf:role="aut">${author}</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="coverimg"/>
  </metadata>
  <manifest>
${chapters.map((c, i) => `    <item id="c${i + 1}" href="${hrefs[i]}" media-type="application/xhtml+xml"/>`).join("\n")}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="coverimg" href="../IMAGES/cover.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">${chapters.map((c, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine>
</package>`);
  const zip = zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    ...files,
  });
  return Buffer.from(zip);
}

/* A "zip bomb" the test process can actually hold: a normal small EPUB whose
   CENTRAL DIRECTORY lies about one entry's uncompressed size. fflate reads
   originalSize from the central directory and hands it to the `filter` callback
   BEFORE allocating the buffer for that entry, which is exactly where parseEpub's
   inflate budget lives — so the lie is never called (nothing is inflated) and the
   fixture stays a few KB on disk while declaring half a gigabyte. */
function makeZipBomb(declaredBytes = 512 * 1024 * 1024) {
  const buf = makeEpub({ cover: false });
  const target = "OEBPS/ch1.xhtml";
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue; /* central directory file header */
    const nameLen = buf.readUInt16LE(i + 28);
    if (buf.toString("latin1", i + 46, i + 46 + nameLen) !== target) continue;
    buf.writeUInt32LE(declaredBytes, i + 24); /* uncompressed size */
    return buf;
  }
  throw new Error(`makeZipBomb: no central directory record for ${target}`);
}

async function importEpub(page, opts) {
  await page.setInputFiles("#bookFile", {
    name: (opts && opts.name) || "test.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.isBuffer(opts) ? opts : makeEpub(opts),
  });
}

module.exports = { makeEpub, makeEpub2, makeZipBomb, importEpub, DEFAULT_CHAPTERS };
