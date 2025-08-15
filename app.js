//This is server, how you run 
//main entry point and HTTP server

require('dotenv').config();

// Import required modules
const fs = require('fs'); // File system module to work with the file system
const express = require('express'); // Express framework for building web applications
const path = require('path'); // Path module to work with file and directory paths
const { exec } = require('child_process'); // Node.js module to execute shell commands
const { 
    processEmail, 
    checkAttachmentCount, 
    filterConfig, 
    checkContentModeration, 
    handlePostmarkWebhook 
} = require('./emailfilter'); // Custom email filtering module
//i am creating const func and var that are assigned to what we chose to export from emailfilter.js
const bodyParser = require('express').json();

// Create an instance of an Express application
const app = express();

// Important: Add middleware BEFORE routes
app.use(express.json({ limit: '10mb' })); //10 megabytes. is also postmark's limit
//This is Express’s built-in middleware that parses application/json request bodies 
// (like {"name": "Alice"}), and makes the result available on req.body.
// 10 megabytes maximum size of the incoming JSON payload that the server will accept
app.use(express.static(path.join(__dirname, 'public')));

// Define the port number for the server to listen on or Cloud Run dynamically assigns a port
const PORT = process.env.PORT || 3000;

// Define the path to the JSON file that will be read
const jsonFilePath = path.join(__dirname, 'json', 'sample_postmark_email.json');
//__dirname: absolute directory path of the current file (e.g., /Users/you/project/src)
//             + starting point (base path) for a relative file path
//'json' parameter: subdirectory name
//  - when appended to __dirname, refers to a folder named json inside the current file's directory
//'sample_postmark_email.json': file name you want to access
//  - when appended to the path, indicating the specific file inside the json directory
// path.join(...) joins all arguments using the correct file separator for your OS (/), 
//         so this is <directory of current file>/json/sample_postmark_email.json

// Function to open URL in the default browser
function openBrowser(url) {
    let command;
    switch (process.platform) {
        case 'darwin':  // macOS
            command = `open ${url}`;
            break;
        case 'win32':   // Windows
            command = `start ${url}`;
            break;
        default:        // Linux and others
            command = `xdg-open ${url}`;
    }
    
    exec(command, (error) => {
        if (error) {
            console.error('Error opening browser:', error);
        }
    });
}

// Add a variable to store the temporary email data
let tempEmailData = null;

// Read the JSON file when the application starts if not cloud run bc doesn't exit on cloud run
//reading sample_postmark_email.json and adding boba to top when display
if (process.env.NODE_ENV !== 'production') {
    fs.readFile(jsonFilePath, 'utf8', (err, data) => {
      if (err) {
        console.error('Error reading the JSON file:', err);
        return;
      }
      const originalData = JSON.parse(data);
      const jsonData = Object.assign({ message: "boba" }, originalData); 
      console.log(jsonData);
    });
  }
  

// Modify the GET endpoint to handle async processEmail
app.get('/api/json-data', async (req, res) => {
    if (tempEmailData) {
        try {
            const isAllowed = await processEmail(tempEmailData);
            const moderationResult = await checkContentModeration(tempEmailData);
            
            const jsonData = {
                message: "boba",
                filterResults: {
                    isAllowed: isAllowed,
                    filterConfig: filterConfig,
                    contentModeration: {
                        text: {
                            passed: !moderationResult.text.flagged,
                            categories: moderationResult.text.categories,
                            scores: moderationResult.text.categoryScores
                        },
                        images: moderationResult.images.map(img => ({
                            type: img.type,
                            filename: img.filename || 'inline-image',
                            passed: !img.moderation.flagged,
                            categories: img.moderation.categories,
                            scores: img.moderation.category_scores
                        })),
                        summary: moderationResult.summary,
                        overallPassed: moderationResult.overallPassed
                    },
                    lengthValidation: {
                        passedMinLength: tempEmailData.From.split('@')[0].length >= filterConfig.length.min,
                        passedMaxLength: tempEmailData.From.length <= filterConfig.length.max,
                        requirements: {
                            minUsernameLength: filterConfig.length.min,
                            maxEmailLength: filterConfig.length.max
                        }
                    },
                    attachmentNum: checkAttachmentCount(tempEmailData.Attachments)
                },
                email: tempEmailData
            };
            res.json(jsonData);
        } catch (error) {
            console.error('Error processing email:', error);
            res.status(500).send('Error processing email');
        }
    } else {
        // Otherwise serve the file data with filter results
        fs.readFile(jsonFilePath, 'utf8', async (err, data) => { // Make this async
            if (err) {
                console.error('Error reading the JSON file:', err);
                res.status(500).send('Error reading the JSON file');
                return;
            }
            const originalData = JSON.parse(data);
            const moderationResult = await checkContentModeration(originalData);
            const jsonData = {
                message: "boba",
                filterResults: {
                    isAllowed: await processEmail(originalData), // Make this await
                    filterConfig: filterConfig,
                    contentModeration: {
                        text: {
                            passed: !moderationResult.text.flagged,
                            categories: moderationResult.text.categories,
                            scores: moderationResult.text.categoryScores
                        },
                        images: moderationResult.images.map(img => ({
                            type: img.type,
                            filename: img.filename || 'inline-image',
                            passed: !img.moderation.flagged,
                            categories: img.moderation.categories,
                            scores: img.moderation.category_scores
                        })),
                        summary: moderationResult.summary,
                        overallPassed: moderationResult.overallPassed
                    },
                    lengthValidation: {
                        passedMinLength: originalData.From.split('@')[0].length >= filterConfig.length.min,
                        passedMaxLength: originalData.From.length <= filterConfig.length.max,
                        requirements: {
                            minUsernameLength: filterConfig.length.min,
                            maxEmailLength: filterConfig.length.max
                        }
                    },
                    attachmentNum: checkAttachmentCount(originalData.Attachments)
                },
                email: originalData
            };

            const imagePath = path.join(__dirname, 'public', 'image.png');
            fs.readFile(imagePath, (imageErr, imageData) => {
                if (imageErr) {
                    console.error('Error reading the image file:', imageErr);
                    res.status(500).send('Error reading the image file');
                    return;
                }
                jsonData.imageBase64 = imageData.toString('base64');
                res.json(jsonData);
            });
        });
    }
});

// Modify the POST endpoint to use temporary storage instead of file
app.post('/api/email', (req, res) => { //local testing only
    let emailData = '';

    // Collect the incoming email data from curl
    req.on('data', chunk => {
        emailData += chunk;
    });

    req.on('end', () => {
        try {
            const parsedEmail = JSON.parse(emailData);
            // Store the new email data in memory instead of writing to file
            tempEmailData = parsedEmail;

            // Open a new browser window to display the temporary email data
            openBrowser('http://localhost:3000');
            res.status(200).send('Email received and browser window opened');
    } catch (error) {
            console.error('Error parsing the email data:', error);
            res.status(400).send('Invalid email data');
    }
    });
});

// Update the webhook route to include Google Sheets integration
app.post('/webhook/email', handlePostmarkWebhook);

// Start the server and listen on the specified port
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    // Open browser automatically when server starts
    //openBrowser(`http://localhost:${PORT}`);
});