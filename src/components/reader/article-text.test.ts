import { describe, expect, test } from "bun:test";
import {
  articleGist,
  countWords,
  listedTickers,
  markTerms,
  parseArticle,
  splitParagraph,
  splitSentences,
  type ArticleBlock,
} from "./article-text";

// Invented stories: every company, ticker, person and figure is made up.

const WIRE_PAGE = [
  "Wirefeed Daily",
  "Corvane Robotics Raises Full-Year Outlook",
  "News provided by",
  "Corvane Robotics Inc.",
  "Oct 09, 2026, 08:00 ET",
  "Share this article",
  "Share to X",
  "Share to LinkedIn",
  "BOSTON, Oct. 9, 2026 /Wirefeed/ -- Corvane Robotics Inc. (NASDAQ: CRVN) said third-quarter revenue rose 18% to $412 million. Gross margin was 46.2%.",
  "Chief executive Mara Lindqvist said warehouse customers ordered more picking arms than ever.",
  "View original content to download multimedia: https://wirefeed.example/corvane",
  "SOURCE Corvane Robotics Inc.",
].join("\n");

function text(blocks: ArticleBlock[]): string {
  return blocks.map((block) => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        return block.text;
      case "list":
        return block.items.join(" ");
      case "table":
        return block.rows.map((row) => row.join(" ")).join(" ");
    }
  }).join(" ");
}

function news(body: string, title = "Corvane Robotics Raises Full-Year Outlook") {
  return parseArticle([{ text: body }], { title, source: "Wirefeed Daily", clean: true });
}

describe("cleaning", () => {
  test("drops the page furniture around a wire release and keeps every sentence of it", () => {
    const blocks = news(WIRE_PAGE);
    expect(text(blocks)).toBe(
      "Corvane Robotics Inc. (NASDAQ: CRVN) said third-quarter revenue rose 18% to $412 million. Gross margin was 46.2%. "
      + "Chief executive Mara Lindqvist said warehouse customers ordered more picking arms than ever.",
    );
  });

  test("takes the other wires' datelines, and only with a wire tag", () => {
    const globe = news("NEW YORK, Oct. 9, 2026 (GLOBE NEWSWIRE) -- Ondine Memory Inc. opened a plant.");
    expect(text(globe)).toBe("Ondine Memory Inc. opened a plant.");
    const business = news("SAN FRANCISCO--(BUSINESS WIRE)--Pellam Devices plc named a new chair.");
    expect(text(business)).toBe("Pellam Devices plc named a new chair.");
    // A place in capitals with no wire after it is how a reporter opens a story.
    const reported = news("HALIFAX, NS \u2014 Kestrel Foundry said orders rose.");
    expect(text(reported)).toBe("HALIFAX, NS \u2014 Kestrel Foundry said orders rose.");
  });

  test("keeps sentences that only sound like page chrome", () => {
    const body = [
      "Share prices of Corvane rose 4% on Monday.",
      "The bakery chain said it would accept returns and that cookie sales rose 12% in the quarter, the best since it began selling them in stores across the region.",
      "Subscribers to the company's software grew to 41,000, up from 30,000 a year earlier, as the newsletter business added three titles.",
      "Email remained the largest channel.",
    ].join("\n");
    expect(text(news(body))).toBe(body.replaceAll("\n", " "));
  });

  test("drops cookie banners, newsletter asks and share rows wherever they are", () => {
    const body = [
      "Northwind Freight kept its outlook.",
      "We use cookies to improve your experience. Accept all cookies",
      "Subscribe to our newsletter for the latest freight news.",
      "Share on Facebook",
      "Advertisement",
      "Revenue rose 7.9%.",
    ].join("\n");
    expect(text(news(body, "Northwind"))).toBe("Northwind Freight kept its outlook. Revenue rose 7.9%.");
  });

  test("drops the headline and a lone date only at the top", () => {
    const filler = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1} of the story.`);
    const body = ["Corvane Robotics Raises Full-Year Outlook", "October 9, 2026", ...filler, "Corvane Robotics Raises Full-Year Outlook", "October 9, 2026"].join("\n");
    const result = text(news(body));
    expect(result.startsWith("Paragraph 1 of the story.")).toBe(true);
    // Past the header the same words are the article quoting itself, so they stay.
    expect(result.endsWith("Corvane Robotics Raises Full-Year Outlook October 9, 2026")).toBe(true);
  });

  test("leaves a transcript or a filing as written", () => {
    const blocks = parseArticle([{ text: "Share this article\nThank you, operator." }], { clean: false });
    expect(text(blocks)).toBe("Share this article Thank you, operator.");
  });
});

describe("sentences", () => {
  test("does not break after abbreviations, initials, months or numbers", () => {
    expect(splitSentences(
      "Kestrel Foundry Corp. said U.S. orders rose. J. P. Varga, the CFO, spoke on Oct. 10 about plant No. 5. Shares rose 4.1% to $12.50! \"It was a record.\" Then it fell.",
    )).toEqual([
      "Kestrel Foundry Corp. said U.S. orders rose.",
      "J. P. Varga, the CFO, spoke on Oct. 10 about plant No. 5.",
      "Shares rose 4.1% to $12.50!",
      "\"It was a record.\"",
      "Then it fell.",
    ]);
  });

  test("splits a long paragraph between sentences into even runs", () => {
    const sentences = Array.from({ length: 9 }, (_, index) => `Sentence ${index + 1} has exactly eight words in it.`.replace("exactly eight", index % 3 === 0 ? "a few more words than eight" : "exactly eight"));
    const paragraph = sentences.join(" ");
    const parts = splitParagraph(paragraph);
    expect(parts.join(" ")).toBe(paragraph);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(countWords(part)).toBeLessThanOrEqual(45);
    // Runs end on a sentence, never inside one.
    for (const part of parts) expect(part.endsWith(".")).toBe(true);
  });

  test("keeps a short paragraph and a single long sentence whole", () => {
    const short = "Gross margin was 46.2%. Shares rose 6% in premarket trading.";
    expect(splitParagraph(short)).toEqual([short]);
    const long = `${Array.from({ length: 80 }, () => "word").join(" ")}.`;
    expect(splitParagraph(long)).toEqual([long]);
  });
});

describe("blocks", () => {
  test("reads a table, a list and the heading over a company's news", () => {
    const blocks = news([
      "Highlights (in millions):",
      "Metric            Q2 2026    Q2 2025    Change",
      "Revenue           $1,284     $1,190     +7.9%",
      "Diluted EPS       $1.12      $0.94      +19.1%",
      "\u2022 Record truckload volume",
      "\u2022 Fuel costs fell",
      "Halvard Microsystems (NASDAQ: HLVD )",
      "Halvard shares reached a record high on October 5 after the company confirmed early talks about supplying chips.",
    ].join("\n"), "Northwind");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "list", "heading", "paragraph"]);
    expect(blocks[1]).toMatchObject({ rows: [["Metric", "Q2 2026", "Q2 2025", "Change"], ["Revenue", "$1,284", "$1,190", "+7.9%"], ["Diluted EPS", "$1.12", "$0.94", "+19.1%"]] });
    expect(blocks[2]).toMatchObject({ items: ["Record truckload volume", "Fuel costs fell"] });
    // The gap wire text leaves inside the brackets goes.
    expect(blocks[3]).toMatchObject({ text: "Halvard Microsystems (NASDAQ: HLVD)" });
  });

  test("splits bullets run together on one line", () => {
    const blocks = news("Highlights: \u2022 Revenue up 8% \u2022 Margin of 46% \u2022 Outlook kept", "Northwind");
    expect(blocks).toMatchObject([
      { kind: "paragraph", text: "Highlights:" },
      { kind: "list", items: ["Revenue up 8%", "Margin of 46%", "Outlook kept"] },
    ]);
  });

  test("joins hard-wrapped lines back into their paragraphs", () => {
    const wrapped = "Northwind Freight reported results on Thursday, with revenue up\n7.9% as volume recovered.\n\nThe board kept its dividend at\n$0.31 a share.";
    expect(news(wrapped, "Northwind")).toMatchObject([
      { kind: "paragraph", text: "Northwind Freight reported results on Thursday, with revenue up 7.9% as volume recovered." },
      { kind: "paragraph", text: "The board kept its dividend at $0.31 a share." },
    ]);
    // Without blank lines a line break is a paragraph break, unless the next line plainly continues.
    expect(news("Revenue rose 7.9%.\nThe board kept its dividend at\n$0.31 a share.", "Northwind")).toMatchObject([
      { kind: "paragraph", text: "Revenue rose 7.9%." },
      { kind: "paragraph", text: "The board kept its dividend at $0.31 a share." },
    ]);
  });

  test("heads each speaker's turn once", () => {
    const blocks = parseArticle([
      { heading: "Dana Okafor \u00b7 CEO", text: "Volume recovered." },
      { heading: "Dana Okafor \u00b7 CEO", text: "Fuel costs fell." },
      { heading: "Operator", text: "Next question." },
    ]);
    expect(blocks.filter((block) => block.kind === "heading").map((block) => block.kind === "heading" && block.text))
      .toEqual(["Dana Okafor \u00b7 CEO", "Operator"]);
  });
});

describe("gist", () => {
  const LONG = [
    "Chip stocks started October on firm footing before giving back ground through the week. The mood turned on Thursday after a report on data center spending.",
    "The Orbis Semiconductor Index finished the week down 4.1% while the broader market slipped 0.6%. Analysts said the move was orderly.",
    "Halvard Microsystems (NASDAQ: HLVD)",
    "Halvard reported September revenue of $2.41 billion, up 38.2% from a year earlier. The company also confirmed talks about a research campus in Ohio, calling them preliminary and early.",
    "Kestrel Foundry Corp. (NYSE: KSTF)",
    "Kestrel shares fell 7.3% for the week after a customer moved part of its orders. It said the change affects less than 3% of output, and that its order book for the first half of 2027 is full.",
    "Ondine Memory Inc. (NASDAQ: ONDM)",
    "It gained 2.2% for the week. Chief financial officer Ilse Varga said memory prices would stay firm through the middle of 2027, citing demand from data center builders and phone makers.",
    ...Array.from({ length: 6 }, () => "The group has more than doubled this year as investors bet on spending for artificial intelligence, and several members trade near record valuations against their own history."),
  ].join("\n");

  test("leads with the opening paragraph and lists sentences that carry a figure and a move", () => {
    const blocks = news(LONG, "Chip Stocks Cool");
    const gist = articleGist(blocks);
    expect(gist.lead).toBe("Chip stocks started October on firm footing before giving back ground through the week. The mood turned on Thursday after a report on data center spending.");
    expect(gist.body[0]?.kind === "paragraph" && gist.body[0].text).toStartWith("The Orbis Semiconductor Index");
    expect(gist.facts).toEqual([
      "The Orbis Semiconductor Index finished the week down 4.1% while the broader market slipped 0.6%.",
      "Halvard reported September revenue of $2.41 billion, up 38.2% from a year earlier.",
      "Kestrel shares fell 7.3% for the week after a customer moved part of its orders.",
    ]);
    // Extractive: every fact is the article's own sentence. "It gained 2.2%" is not one, since it needs the heading above it.
    for (const fact of gist.facts) expect(LONG).toContain(fact);
  });

  test("prefers the article's own summary and keeps every paragraph in the body", () => {
    const blocks = news(LONG, "Chip Stocks Cool");
    const gist = articleGist(blocks, { summary: "Chip stocks fell for the week as data center spending came into question." });
    expect(gist.lead).toBe("Chip stocks fell for the week as data center spending came into question.");
    expect(gist.body).toEqual(blocks);
  });

  test("gives a short story no facts, since it is read whole", () => {
    const gist = articleGist(news(WIRE_PAGE));
    expect(gist.facts).toEqual([]);
    expect(gist.lead).toStartWith("Corvane Robotics Inc. (NASDAQ: CRVN)");
  });
});

test("listed tickers come from US listings only, in order of appearance", () => {
  expect(listedTickers(
    "Halvard (NASDAQ: HLVD ), Kestrel (NYSE: KSTF), Halvard again (Nasdaq: HLVD), Maple Ore (TSX: MPO), Ondine (NYSE American: ONDM; TSX: OND) and the ARM of the deal",
  )).toEqual(["HLVD", "KSTF", "ONDM"]);
});

test("search terms are marked case-insensitively, the longest first", () => {
  expect(markTerms("Free cash flow and cash", ["cash", "free cash flow"])).toEqual([
    { text: "Free cash flow", marked: true },
    { text: " and ", marked: false },
    { text: "cash", marked: true },
  ]);
  expect(markTerms("plain body", [])).toEqual([{ text: "plain body", marked: false }]);
});
