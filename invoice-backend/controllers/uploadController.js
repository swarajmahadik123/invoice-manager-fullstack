import fs from "fs/promises";
import path from "path";
import multer from "multer";
import xlsx from "xlsx";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";

// Get the directory name dynamically for ES modules
const __dirname = "D:Swipeinvoice-backend";

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI("AIzaSyAxqBScjTKmx8eQkLz5uxyotI1eF7Y-7FA");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
const fileManager = new GoogleAIFileManager(
  "AIzaSyAxqBScjTKmx8eQkLz5uxyotI1eF7Y-7FA"
);

// Enhanced multer storage configuration
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, "uploads");

    try {
      // Use async mkdir to ensure directory exists
      await fs.mkdir(uploadPath, { recursive: true });
      cb(null, uploadPath);
    } catch (error) {
      cb(error, null);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.fieldname}${ext}`);
  },
});

// Comprehensive file filter with more detailed validation
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // Excel
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/jpg",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // Word
  ];

  // Check both MIME type and file extension
  const allowedExtensions = [".xlsx", ".pdf", ".jpeg", ".png", ".jpg", ".docx"];
  const fileExtension = path.extname(file.originalname).toLowerCase();

  if (
    allowedTypes.includes(file.mimetype) ||
    allowedExtensions.includes(fileExtension)
  ) {
    cb(null, true);
  } else {
    const error = new Error("Unsupported file format");
    error.code = "UNSUPPORTED_FILE_TYPE";
    cb(error, false);
  }
};

// Initialize Multer with enhanced configuration
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5, // Limit number of files to 5
  },
});

// Function to convert Excel to CSV
async function convertExcelToCSV(filePath) {
  try {
    // Read the Excel file
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to CSV
    const csvContent = xlsx.utils.sheet_to_csv(worksheet);
    
    // Create a temporary CSV file
    const csvPath = filePath.replace('.xlsx', '.csv');
    await fs.writeFile(csvPath, csvContent, 'utf-8');
    
    return csvPath;
  } catch (error) {
    throw new Error(`Failed to convert Excel to CSV: ${error.message}`);
  }
}

// Function to extract data from Excel file


// Improved file processing function with Excel handling
async function processFiles(files) {
  const extractedTexts = [];
  const processingErrors = [];
  const temporaryFiles = []; // Track temporary files for cleanup

  for (const file of files) {
    try {
      const fileExtension = path.extname(file.originalname).toLowerCase();
      let fileToProcess = file.path;
      let mimeType = file.mimetype;

      // Handle Excel files
      if (fileExtension === '.xlsx') {
        try {
          const csvPath = await convertExcelToCSV(file.path);
          fileToProcess = csvPath;
          mimeType = 'text/csv';
          temporaryFiles.push(csvPath); // Track CSV file for cleanup
        } catch (conversionError) {
          throw new Error(`Excel conversion failed: ${conversionError.message}`);
        }
      }

      const uploadResponse = await fileManager.uploadFile(fileToProcess, {
        mimeType: mimeType,
        displayName: path.basename(fileToProcess),
      });

      console.log(`Uploaded file ${uploadResponse.file.displayName} as: ${uploadResponse.file.uri}`);

      // Generate content using the uploaded file
      const result = await model.generateContent([
        {
          fileData: {
            mimeType: uploadResponse.file.mimeType,
            fileUri: uploadResponse.file.uri,
          },
        },
        {
          text: "Please analyze these files and extract information into three structured tables. The files may contain invoices, product information, and customer details. only give json do not give extra text. Format the response as JSON with the following structure:" +
            JSON.stringify({
              invoices: [{
                serialNumber: "string",
                customerName: "string",
                productName: "string",
                quantity: "number",
                tax: "number",
                totalAmount: "number",
                date: "string"
              }],
              products: [{
                name: "string",
                quantity: "number",
                unitPrice: "number",
                tax: "number",
                priceWithTax: "number",
                discount: "number (optional)"
              }],
              customers: [{
                customerName: "string",
                phoneNumber: "string",
                totalPurchaseAmount: "number",
                email: "string (optional)",
                address: "string (optional)"
              }]
            }, null, 2)
        }
      ]);

      // Parse the response
      let parsedText;
      try {
        const cleanedText = result.response.candidates[0].content.parts[0].text
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();
          console.log(cleanedText)
        parsedText = JSON.parse(cleanedText);
      } catch (parseError) {
        throw new Error(`Failed to parse JSON: ${parseError.message}`);
      }

      extractedTexts.push({
        filename: file.originalname,
        extractedData: parsedText
      });

    } catch (error) {
      console.error(`Error processing file ${file.originalname}:`, error);
      processingErrors.push({
        filename: file.originalname,
        errorMessage: error.message
      });
    }
  }

  // Clean up temporary files
  for (const tempFile of temporaryFiles) {
    try {
      await fs.unlink(tempFile);
    } catch (error) {
      console.error(`Error deleting temporary file ${tempFile}:`, error);
    }
  }

  return { extractedTexts, processingErrors };
}

// Upload files handler
export const uploadFiles = async (req, res) => {
  try {
    // Validate file upload
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files selected",
      });
    }

    // Process files with comprehensive error handling
    const { extractedTexts, processingErrors } = await processFiles(req.files);

    // Async file cleanup
    const cleanupPromises = req.files.map(async (file) => {
      try {
        await fs.unlink(file.path);
      } catch (unlinkError) {
        console.error(`Error deleting file ${file.originalname}:`, unlinkError);
      }
    });

    // Wait for all cleanup operations
    await Promise.all(cleanupPromises);

    // Prepare response
    const response = {
      success: true,
      data: extractedTexts,
      filesProcessed: req.files.length,
    };

    // Add errors to response if any occurred
    if (processingErrors.length > 0) {
      response.errors = processingErrors;
    }

    res.status(200).json(response);
  } catch (error) {
    console.error("Comprehensive upload handler error:", error);

    // Attempt to cleanup files even in error scenario
    if (req.files) {
      const cleanupPromises = req.files.map(async (file) => {
        try {
          await fs.unlink(file.path);
        } catch (unlinkError) {
          console.error(`Error deleting file in error handler:`, unlinkError);
        }
      });

      await Promise.all(cleanupPromises);
    }

    res.status(500).json({
      success: false,
      error: "Failed to process files",
      details: error.message,
    });
  }
};

// Multer middleware to handle file uploads (for array of files)
export const uploadMiddleware = upload.array("files", 5); // Limit to 5 file
