/**
 * Refreshes the major listings that ship with the app,
 * `src/tickers/search/major-listings.json`: `bun run listings:snapshot`.
 * The command bar names these symbols' listings the moment one is typed,
 * before search answers, and the app re-reads them a slice a day.
 *
 * Every symbol below is asked of Gloom Cloud's batched search, the search the
 * bar asks, signed out and paced under its allowance for a list; the lines it
 * answers for the symbol are written as it sent them, in its order. A symbol
 * search finds no line of is printed and left out, never written by hand.
 *
 * The symbols are the large companies and funds of each market: the indexes'
 * members (S&P 100 and the Nasdaq 100's largest, the Hang Seng, the CSI 300's
 * largest, the STI, the Nikkei 225's largest, the Euro Stoxx 50, the FTSE 100,
 * the DAX, the CAC 40, the SMI and the Nordic leaders) and the funds people
 * trade most.
 */
import { writeFile } from "fs/promises";
import { join } from "path";
import { createGloomberbCloudProvider } from "../src/sources/gloomberb-cloud";
import { directoryRows, encodeKeptListing, LISTING_ANSWER_LIMIT, listingIndexKey, type KeptListing } from "../src/tickers/search/listing-index";

const SNAPSHOT_PATH = join(import.meta.dir, "..", "src", "tickers", "search", "major-listings.json");

const SYMBOLS: Record<string, string> = {
  us: `
    AAPL MSFT NVDA GOOGL GOOG AMZN META AVGO TSLA BRK.B LLY JPM V UNH XOM MA WMT JNJ PG HD COST ORCL ABBV BAC KO MRK
    CVX NFLX CRM AMD PEP TMO ADBE LIN WFC CSCO ACN MCD ABT DIS IBM GE CAT INTU QCOM TXN VZ AMGN PFE NOW DHR PM ISRG UBER
    GS CMCSA NEE AMAT SPGI RTX HON UNP T LOW AXP BKNG PGR COP MS BLK SYK ELV TJX LMT SCHW VRTX C REGN MDT PLD BSX ETN
    ADP MMC CB DE ADI PANW MU LRCX SBUX GILD BMY KLAC SO MO ANET CI ICE DUK SHW ZTS CME INTC MCK CL PYPL EQIX CDNS SNPS
    APH TT WM ITW MCO USB PLTR CRWD ABNB SHOP XYZ COIN HOOD SNOW MRVL ARM SMCI DELL TSM BABA PDD NIO JD BIDU TM SONY NVO
    MSTR RIVN LCID F GM BA DAL UAL AAL CCL NKE TGT FDX UPS KHC MDLZ GIS HSY MNST KDP STZ EL DG DLTR ROST ORLY AZO CMG
    YUM DPZ MAR HLT RCL NCLH LVS WYNN MGM EA TTWO RBLX U DDOG NET ZS OKTA MDB TEAM WDAY ADSK FTNT ROP CPRT PAYX CTAS FAST
    ODFL CSX NSC CP CNI MMM EMR GD NOC HII TDG HWM WMB KMI OKE EPD ET SLB HAL OXY EOG DVN FANG MPC PSX VLO AEP D EXC SRE
    PCG ED XEL CEG VST NRG GEV O SPG PSA AMT CCI DLR WELL VICI AVB EQR MET PRU AIG AFL ALL TRV HIG PNC TFC COF BK STT
    KKR APO BX CVS HUM CNC HCA MRNA BIIB DXCM IDXX EW A IQV RMD ZBH BDX BAX WBA KR SYY ADM TSN CAG HRL CPB CHD CLX KMB
    WDC STX HPQ HPE NTAP ON NXPI MCHP SWKS QRVO TER ENPH FSLR SEDG ROKU SPOT PINS SNAP LYFT DASH TWLO DOCU ZM SOFI AFRM
    UPST PATH AI IONQ RGTI SOUN CVNA CHWY ETSY EBAY W BBY GME AMC BYND PTON DKNG CELH ELF LULU DECK CROX ONON BIRK
  `,
  usFunds: `
    SPY QQQ IWM DIA VOO VTI IVV VEA VWO VXUS BND AGG EFA EEM GLD SLV IAU TLT IEF SHY BIL SGOV HYG LQD JNK XLK XLF XLE
    XLV XLY XLP XLI XLU XLB XLRE XLC SMH SOXX IGV ARKK TQQQ SQQQ SPXL SOXL SOXS UVXY VXX GDX GDXJ USO UNG BITO IBIT
    FBTC ETHA GBTC FXI KWEB MCHI EWJ EWH EWS EWT EWY INDA VGK EWG EWU EWZ SCHD JEPI JEPQ VIG VYM DGRO RSP MDY IJH IJR
    VUG VTV QUAL MTUM USMV
  `,
  hk: `
    0700 0005 0939 1299 0941 1398 3988 0388 2318 9988 3690 1810 9618 9999 1211 0883 0857 0386 2628 0001 0002 0003 0006
    0011 0012 0016 0017 0027 0066 0101 0175 0267 0285 0288 0291 0316 0322 0669 0688 0762 0823 0836 0868 0881 0960 0968
    0981 0992 1038 1044 1088 1093 1109 1113 1177 1876 1928 1997 2020 2269 2313 2319 2331 2382 2388 2688 3328 3968 6098
    6618 6690 9633 9888 9961 9868 2015 1024 3692 1801 6862 2899 3993 1347 0020 0700 9626 9866 2057 1929 0151 0019 0023
    0083 0144 0241 0293 0330 0358 0384 0390 0656 0728 0753 0857 0880 0914 0916 0939 0995 1071 1099 1137
    1171 1186 1209 1288 1336 1339 1359 1658 1766 1772 1818 1833 1898 1919 2007 2202 2208 2238 2333 2359 2400 2601 2618
    2638 2669 2828 2800 3033 3067 3311 3323 3600 3800 3808 3888 3898 3900 3908 3958 3998 6030 6060 6160 6186 6969 9901
    9922 9923 9992 9995
  `,
  cn: `
    600519 601318 600036 000858 300750 601012 600900 601166 600276 000333 002594 600030 601398 601288 601988 601857
    600028 600309 000651 002415 600887 601899 300059 000001 600000 601328 603259 300760 002475 600031 601888 688981
    000568 600438 600809 002714 601225 600048 000725 300015 601088 600050 601668 601390 601186 600019 600104 000002
    600585 601919 600406 000063 002230 002371 300124 300274 300308 300502 688041 688111 688256 601138 603288 600690
    000538 600196 600436 601633 002466 002460 601728 600941 601628 601601 601319 600999 601211 000776 600016 601169
    601818 601229 600919 600025 600011 600905 601985 003816 600150 601766 600760 002352 601111 600115 601021 000338
  `,
  sg: `
    D05 O39 U11 Z74 C6L C38U A17U S68 Y92 BN4 F34 G13 V03 C07 U96 S63 BS6 H78 M44U N2IU ME8U 9CI J36 C09 U14 S58 AJBU
    5E2 D01 BUOU K71U T82U J69U HMN CJLU E5H AWX OV8 TQ5 BSL F99 OYY 558 M01 C52 EB5 AIY
  `,
  jp: `
    7203 6758 9984 8306 6861 9432 6098 8035 9983 4063 8058 7974 6501 8316 4502 8001 6367 7267 4568 9433 6902 7741 8766
    6981 8031 4519 6594 6273 6954 9434 8411 7751 6752 4661 2914 6702 6503 4503 8002 8053 5108 6301 7011 4901 3382 9020
    9022 8801 8802 6178 7182 4689 6723 6146 6857 6920 7733 2802 4452 5401 7201 7269 7270 6201 6326 6305 7012 7013 6701
    6762 6971 6988 7832 7735 4543 4507 4523 4578 4911 8591 8604 8725 8750 8309 8308 8473 9101 9104 9107 9201 9202 9501
    9503 9531 1605 5020 5713 3407 4005 4188 6506 6645 6383 7011 9766 9697 4385 3659 2413 4755 9735 8267 3099 8113
  `,
  eu: `
    SAP SIE ALV DTE MBG BMW VOW3 BAS BAYN ADS MUV2 DBK IFX DHL RWE EOAN DB1 HEN3 MRK VNA FRE SHL BEI CBK HNR1 MTX RHM
    ENR P911 PAH3 CON ZAL SY1 QIA HEI DTG AIR MC OR TTE SAN SU AI BNP RMS EL CS KER DG SAF RI GLE ACA BN CAP ORA VIE
    EN HO ML DSY PUB SGO LR VIV URW STMPA ERF AC SHEL AZN HSBA ULVR BP RIO GSK BATS DGE REL LSEG NG LLOY BARC VOD PRU
    AAL GLEN TSCO BA RR IMB CPG EXPN NWG STAN HLN BT.A ABF SSE AV LGEN ASML INGA PRX ADYEN HEIA PHIA AD WKL ASM MT
    AKZA RAND KPN NN ABN NESN NOVN ROG UBSG ZURN ABBN CFR LONN SIKA GIVN ALC SREN HOLN PGHN SCMN GEBN SLHN LOGN ITX IBE
    BBVA TEF REP FER CABK AENA ENEL ISP UCG ENI RACE STLAM G STM PRY MONC LDO NOVO.B MAERSK.B DSV ORSTED CARL.B
    ERIC.B VOLV.B ATCO.A INVE.B HM.B SEB.A NOKIA NESTE EQNR DNB EDP GALP UCB KBC
  `,
};

/** Signed out, searches are rate limited; a list of a hundred a minute stays under it. */
const PAUSE_MS = 60_000;
const BATCH = 100;
/** A request the service turned away (busy, timed out) leaves its symbols out; they are asked again this many times. */
const ROUNDS = 5;

const symbols = [...new Set(Object.values(SYMBOLS).flatMap((list) => list.trim().split(/\s+/)))];
const provider = createGloomberbCloudProvider();
if (!provider.searchBatch) throw new Error("Gloom Cloud's provider cannot batch searches.");

const answered = new Map<string, KeptListing[]>();
let unanswered = symbols;
for (let round = 0; round < ROUNDS && unanswered.length > 0; round++) {
  const asking = unanswered;
  unanswered = [];
  for (let start = 0; start < asking.length; start += BATCH) {
    if (start > 0 || round > 0) await Bun.sleep(PAUSE_MS);
    const chunk = asking.slice(start, start + BATCH);
    const answers = await provider.searchBatch(chunk, { limit: LISTING_ANSWER_LIMIT });
    if (!answers) throw new Error("Gloom Cloud did not answer the batched search.");
    for (const symbol of chunk) {
      const rows = answers.get(symbol);
      if (rows) answered.set(symbol, directoryRows(symbol, rows).map(encodeKeptListing));
      else unanswered.push(symbol);
    }
    console.log(`round ${round + 1}: asked ${Math.min(start + BATCH, asking.length)} of ${asking.length}, ${unanswered.length} turned away`);
  }
}
if (unanswered.length > 0) throw new Error(`Gloom Cloud kept turning away ${unanswered.length} symbols: ${unanswered.join(" ")}`);

// In the order the symbols are listed, which is the order the app re-reads them in.
const byKey = new Map<string, KeptListing[]>();
const missing: string[] = [];
for (const symbol of symbols) {
  const rows = answered.get(symbol) ?? [];
  if (rows.length === 0) missing.push(symbol);
  else byKey.set(listingIndexKey(symbol), rows);
}

const listings = [...byKey.values()].flat();
// A listing a line, so a refresh reads as the lines that changed.
const body = listings.map((row) => JSON.stringify(row)).join(",\n");
await writeFile(SNAPSHOT_PATH, `{"generatedAt":${JSON.stringify(new Date().toISOString().slice(0, 10))},"listings":[\n${body}\n]}\n`);
console.log(`Wrote ${SNAPSHOT_PATH}: ${byKey.size} symbols, ${listings.length} listings.`);
if (missing.length > 0) console.log(`Search found no line of ${missing.length}: ${missing.join(" ")}`);
