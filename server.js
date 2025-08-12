require("dotenv").config()
const express = require("express")
const multer = require("multer")
const cors = require("cors")
const fs = require("fs")
const path = require("path")
const OpenAI = require("openai")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads")
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9)
    cb(null, uniqueSuffix + "-" + file.originalname)
  },
})

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
  ]

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error("Invalid file type. Only PDF, DOCX, DOC, and TXT files are allowed."), false)
  }
}

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
})

// Function to extract text from different file types
async function extractTextFromFile(filePath, mimetype) {
  try {
    console.log(`Extracting text from ${mimetype} file: ${filePath}`)

    switch (mimetype) {
      case "application/pdf":
        const pdfBuffer = fs.readFileSync(filePath)
        const pdfData = await pdfParse(pdfBuffer)
        return pdfData.text

      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      case "application/msword":
        const docxResult = await mammoth.extractRawText({ path: filePath })
        return docxResult.value

      case "text/plain":
        return fs.readFileSync(filePath, "utf8")

      default:
        throw new Error(`Unsupported file type: ${mimetype}`)
    }
  } catch (error) {
    console.error("Error extracting text from file:", error)
    throw new Error(`Failed to extract text: ${error.message}`)
  }
}

// Function to extract data using OpenAI
async function extractDataWithOpenAI(text, apiKey) {
  // Initialize OpenAI client with the provided API key
  const openai = new OpenAI({
    apiKey: apiKey,
  })

  // First, classify the document
  const classificationPrompt = `Analyze the following document text. Is it a contract, agreement, legal document, or a similar formal document outlining terms and conditions between parties? Respond with "YES" if it is, and "NO" if it is not. Do NOT include any other text or explanation.

Document text (first 1000 characters):
${text.substring(0, 1000)}`

  try {
    console.log("Classifying document type with OpenAI...")
    const classificationResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a document classifier. Respond only with 'YES' or 'NO'.",
        },
        {
          role: "user",
          content: classificationPrompt,
        },
      ],
      temperature: 0, // Keep temperature low for deterministic answers
      max_tokens: 5, // Just enough for "YES" or "NO"
    })

    const classificationResult = classificationResponse.choices[0].message.content.trim().toUpperCase()
    console.log("Classification result:", classificationResult)

    if (classificationResult !== "YES") {
      throw new Error("Invalid document type: This document does not appear to be a contract or agreement.")
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

Return only the JSON object, no additional text or explanation.`

    console.log("Sending full extraction request to OpenAI...")

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
    })

    console.log("OpenAI extraction response received")

    let rawContent = extractionResponse.choices[0].message.content

    // Remove markdown code block fences if present
    if (rawContent.startsWith("```json") && rawContent.endsWith("```")) {
      rawContent = rawContent.substring(7, rawContent.length - 3).trim()
      console.log("Stripped markdown fences from OpenAI response.")
    } else if (rawContent.startsWith("```") && rawContent.endsWith("```")) {
      rawContent = rawContent.substring(3, rawContent.length - 3).trim()
      console.log("Stripped generic markdown fences from OpenAI response.")
    }

    let extractedData
    try {
      extractedData = JSON.parse(rawContent)
    } catch (parseError) {
      console.error("JSON parse error after stripping fences:", parseError)
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
      }
    }

    // Add token usage information from both calls
    extractedData.promptTokens =
      (classificationResponse.usage?.prompt_tokens || 0) + (extractionResponse.usage?.prompt_tokens || 0)
    extractedData.completionTokens =
      (classificationResponse.usage?.completion_tokens || 0) + (extractionResponse.usage?.completion_tokens || 0)
    extractedData.totalTokens =
      (classificationResponse.usage?.total_tokens || 0) + (extractionResponse.usage?.total_tokens || 0)

    return extractedData
  } catch (error) {
    console.error("Error with OpenAI processing:", error)
    throw error // Re-throw the error to be caught by the /extract endpoint
  }
}

// Routes

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    note: "OpenAI API key should be provided in request body for /extract endpoint",
  })
})

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
  })
})

// Main extraction endpoint
app.post("/extract", upload.single("document"), async (req, res) => {
  console.log("Extract endpoint called")

  try {
    // Check if OpenAI API key is provided in request body
    const openaiApiKey = req.body.openaiApiKey
    if (!openaiApiKey || openaiApiKey.trim() === "") {
      return res.status(400).json({
        error: "Missing API key",
        message: "OpenAI API key must be provided in the request body as 'openaiApiKey'",
      })
    }

    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF, DOCX, DOC, or TXT file",
      })
    }

    console.log("Processing file:", req.file.originalname, "Type:", req.file.mimetype)

    // Extract text from the uploaded file
    const extractedText = await extractTextFromFile(req.file.path, req.file.mimetype)

    if (!extractedText || extractedText.trim().length === 0) {
      // Clean up file
      fs.unlinkSync(req.file.path)
      return res.status(400).json({
        error: "No text found in document",
        message: "The uploaded document appears to be empty or unreadable",
      })
    }

    console.log("Text extracted successfully, length:", extractedText.length)

    // Use OpenAI to extract structured data with the provided API key
    const extractedData = await extractDataWithOpenAI(extractedText, openaiApiKey)

    // Clean up uploaded file
    fs.unlinkSync(req.file.path)

    console.log("Data extraction completed successfully")

    res.json({
      success: true,
      data: extractedData,
      metadata: {
        filename: req.file.originalname,
        fileSize: req.file.size,
        textLength: extractedText.length,
        processedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error("Error processing document:", error)

    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path)
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError)
      }
    }

    // Check for the specific "Invalid document type" error
    if (error.message.includes("Invalid document type")) {
      return res.status(400).json({
        error: "Invalid Document",
        message: error.message,
      })
    }

    // Check for OpenAI API key related errors
    if (error.message.includes("Incorrect API key") || error.message.includes("Invalid API key")) {
      return res.status(401).json({
        error: "Invalid API key",
        message: "The provided OpenAI API key is invalid or incorrect",
      })
    }

    res.status(500).json({
      error: "Processing failed",
      message: error.message || "An error occurred while processing the document",
    })
  }
})

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Middleware error:", error)

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "File too large",
        message: "File size must be less than 10MB",
      })
    }
  }

  res.status(500).json({
    error: "Server error",
    message: error.message || "An unexpected error occurred",
  })
})

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    error: "Not found",
    message: "The requested endpoint does not exist",
  })
})

// Start server
app.listen(PORT, () => {
  console.log("=".repeat(50))
  console.log(`🚀 Document Extractor API Server Started`)
  console.log(`📍 Port: ${PORT}`)
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`)
  console.log(`🔑 OpenAI API Key: Provided via request body`)
  console.log("=".repeat(50))
  console.log(`📋 Health check: http://localhost:${PORT}/health`)
  console.log(`📄 API Structure: http://localhost:${PORT}/structure`)
  console.log(`🔍 Extract endpoint: POST http://localhost:${PORT}/extract`)
  console.log("=".repeat(50))
})

module.exports = app
