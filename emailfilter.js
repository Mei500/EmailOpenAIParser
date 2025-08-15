const OpenAI = require('openai');
const fetch = require('node-fetch');
const blacklistedDomains = require('./blacklistedDomains');

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Configuration object for filter modes and lists
 * Mode 'none' means nothing is blacklisted
 * Mode 'all' means everything is blacklisted (except whitelist)
 * Mode 'list' means check the blacklist array
 */
const filterConfig = { //this is called a configuration object. it is a js object, not json 
    domains: { //domains object, rule group
        //the following are properties of the domains object, overall making configuration fields within a rule group
        mode: 'list',  // 'none', 'all', or 'list'
        whitelist: ['gmail.com', 'outlook.com'],
        blacklist: blacklistedDomains
    },
    usernames: { //usernames object, rule group
        //the following are properties of the usernames object
        mode: 'none',  // 'none', 'all', or 'list'
        whitelist: ['alloweduser', 'gooduser'],
        blacklist: ['spammer', 'badactor']
    },
    length: {
        min: 0,      // keeping minimum length reasonable
        max: null  // "null" (without quotes if no max)
    },
    attachments: {
        maxCount: null  // "null" (without quotes if no max)
    }
};

/**
 * Check if email content length meets requirements
 * @param {Object} emailData - The email data containing content
 * @returns {boolean} - True if length requirements met
 */
function checkEmailLength(emailData) {
    const content = emailData.TextBody || emailData.HtmlBody || '';
    const min = filterConfig.length.min;
    const max = filterConfig.length.max;

    console.log('Content length check:', {
        textLength: emailData.TextBody?.length || 0,
        htmlLength: emailData.HtmlBody?.length || 0,
        minRequired: min,
        maxAllowed: max,
        contentUsed: content
    });
    const meetsMin = content.length >= min;
    const meetsMax = (typeof max !== 'number') || content.length <= max;
    return meetsMin && meetsMax;
}

/**
 * Check if number of attachments meets requirements
 * @param {Array} attachments - Array of email attachments
 * @returns {boolean} - True if attachment count is within limit
 */
function checkAttachmentCount(attachments) {
    const max = filterConfig.attachments.maxCount;
    const count = attachments?.length || 0;

    return typeof max !== 'number' || count <= max;
}

/**
 * treat cid:-referenced attachments as inline images when they match an <img src="cid:..."
 */
function matchCidReferences(html, attachments) {
    const cidRegex = /<img[^>]+src=['"]cid:([^'"]+)['"]/gi;
    const matchedCids = new Set();
    let match;

    while ((match = cidRegex.exec(html)) !== null) {
        matchedCids.add(match[1].toLowerCase());
    }

    return attachments
        .filter(att => att.ContentID && matchedCids.has(att.ContentID.toLowerCase()))
        .map(att => ({
            type: 'inline',
            contentID: att.ContentID.toLowerCase(),  // Include this!
            filename: att.Name,
            contentType: att.ContentType,
            content: att.Content
        }));
}


/**
 * Extract base64 images from HTML content using regex
 * @param {string} htmlContent - HTML content of the email
 * @returns {Array} - Array of {type, content} objects for each found image
 */
function extractInlineImages(htmlContent) {
    // Regex to match base64 encoded images in HTML img tags
    // Captures: group 1 = content type (e.g., 'image/png')
    //          group 2 = base64 content
    const imageRegex = /<img[^>]+src=['"]data:([^'"]+);base64,([^'"]+)['"]/gi;
    const images = [];
    let match;
    console.log("Preview of HTML input:", htmlContent.slice(0, 500));
    // Find all matches in the HTML content
    while ((match = imageRegex.exec(htmlContent)) !== null) {
        images.push({
            type: match[1],    // Content type (e.g., 'image/png')
            content: match[2]  // Base64 encoded image data
        });
    }
    console.log(`Extracted ${images.length} inline images`, images.map(i => i.type));
    return images;
}

async function runWithTimeout(promiseFactory, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const result = await promiseFactory(controller.signal);
        return result;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn(`Request timed out after ${timeoutMs} ms`);
        } else {
            console.error('Request failed:', err);
        }
        return {}; // Return empty object on error or timeout
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Check content using OpenAI's moderation API
 * Handles both text and images (inline and attachments)
 * @param {Object} emailData - The email data containing content and attachments
 * @returns {Promise<Object>} - Moderation results for text and all images
 */
async function checkContentModeration(emailData) {
    try {
        const timeoutMs = 45000; 

        const textContent = emailData.TextBody || '';

        const textResult = await runWithTimeout(
            (signal) => openai.moderations.create({
                model: "omni-moderation-latest",
                input: [{ type: "text", text: textContent }],
                signal
            }),
            timeoutMs
        );
        console.log("MODERATION RESULT:", textResult);

        console.log("HTML Preview:", emailData.HtmlBody?.slice(0, 1000));

        const base64InlineImages = emailData.HtmlBody ? extractInlineImages(emailData.HtmlBody) : [];
        const cidInlineImages = matchCidReferences(emailData.HtmlBody, emailData.Attachments || []);
        const inlineImages = [...base64InlineImages, ...cidInlineImages];

        // Track CIDs used inline so we don’t double-count them in attachment loop
        const excludedCids = new Set(cidInlineImages.map(img => img.contentID?.toLowerCase()).filter(Boolean));

        console.log(`Extracted ${inlineImages.length} inline images`, inlineImages.map(i => i.type));

        const imagePromises = [
            ...inlineImages.map(img => runWithTimeout(
                (signal) => openai.moderations.create({
                    model: "omni-moderation-latest",
                    input: [{ type: "image_url", image_url: { url: `data:${img.contentType};base64,${img.content}` } }],
                    signal
                }),
                timeoutMs
            ).then(result => {
                const moderation = result?.results?.[0];
                if (moderation) {
                    return {
                        type: img.type,  // 'inline'
                        filename: img.filename,
                        moderation
                    };
                }
                return null;
            })),

            ...(emailData.Attachments || [])
                .filter(att => {
                    const cid = att.ContentID?.toLowerCase();
                    return att.ContentType.startsWith('image/') &&
                        (!cid || !excludedCids.has(cid));
                })
                .map(att => runWithTimeout(
                    (signal) => openai.moderations.create({
                        model: "omni-moderation-latest",
                        input: [{ type: "image_url", image_url: { url: `data:${att.ContentType};base64,${att.Content}` } }],
                        signal
                    }),
                    timeoutMs
                ).then(result => {
                    const moderation = result?.results?.[0];
                    if (moderation) {
                        return {
                            type: 'attachment',
                            filename: att.Name,
                            moderation
                        };
                    }
                    return null;
                }))
        ];
        console.log(`Detected ${emailData.Attachments?.length || 0} attachments`);

        const imageResults = (await Promise.all(imagePromises)).filter(Boolean);

        const textModeration = textResult?.results?.[0] || {
            flagged: false,
            categories: {},
            category_scores: {}
        };

        return {
            text: {
                flagged: textModeration.flagged,
                categories: textModeration.categories,
                categoryScores: textModeration.category_scores
            },
            images: imageResults,
            overallPassed: !textModeration.flagged &&
                           !imageResults.some(img => img.moderation.flagged),
            summary: {
                totalImages: imageResults.length,
                inlineImages: imageResults.filter(img => img.type === 'inline').length,
                attachments: imageResults.filter(img => img.type === 'attachment').length,
                flaggedImages: imageResults.filter(img => img.moderation.flagged).length
            }
        };

    } catch (err) {
        console.error('Unexpected content moderation error:', err);
        return {
            text: { flagged: false, categories: {}, categoryScores: {} },
            images: [],
            overallPassed: true,
            summary: { totalImages: 0, inlineImages: 0, attachments: 0, flaggedImages: 0 }
        };
    }
}


//eceives and responds to HTTP POST from Postmark
/**
 * Process email and determine if it should be allowed
 * @param {Object} emailData - The email data from Postmark webhook
 * @returns {boolean} - True if email is allowed, false if blocked
 */
//future: add timeouts to async function
async function processEmail(emailData) { //this is called in app.js, which we run by: node src/app.js
    console.log('Starting email processing...'); 
    // First check basic filters
    if (!checkEmailLength(emailData)) {
        console.log('Failed length check');
        return false;
    }
    if (!checkAttachmentCount(emailData.Attachments)) {
        console.log('Failed attachment check');
        return false;
    }

    // Check content moderation
    const moderationResult = await checkContentModeration(emailData);
    console.log('Moderation result:', moderationResult);
    if (!moderationResult.overallPassed) {
        console.log('Failed moderation check');
        return false;
    }

    // Extract and normalize email components
    const fromEmail = emailData.From.toLowerCase();
    const [username, domain] = fromEmail.split('@');
    
    console.log('Processing with config:', {
        domainsMode: filterConfig.domains.mode,
        usernamesMode: filterConfig.usernames.mode,
        email: fromEmail,
        username,
        domain
    });

    // Process based on domain mode first
    if (filterConfig.domains.mode === 'none') {
        const result = processUsernameMode(username);
        console.log('Username mode result:', result);
        return result;
    }
    else if (filterConfig.domains.mode === 'all') {
        // All domains are blacklisted except whitelist
        if (filterConfig.domains.whitelist.includes(domain)) { //.includes method to check if something exists inside array
            return true;
        }
        // Check username blacklist as final check
        return !filterConfig.usernames.blacklist.includes(username);
    }
    else if (filterConfig.domains.mode === 'list') {
        // Check specific domain blacklist
        if (filterConfig.domains.blacklist.includes(domain)) {
            // Domain is blacklisted, check username whitelist
            return filterConfig.usernames.whitelist.includes(username);
        }
        // Domain not blacklisted, check username blacklist
        return !filterConfig.usernames.blacklist.includes(username);
    }
    return true; // Default allow if mode is invalid
}

/**
 * Helper function to process username mode
 * @param {string} username - The normalized username to check
 * @returns {boolean} - True if username is allowed, false if blocked
 */
function processUsernameMode(username) { //we only use this if no domains are blacklisted. 
                                        //if we used when some domains are blacklisted, this would potentially override domain filtering
    if (filterConfig.usernames.mode === 'none') {
        // No usernames are blacklisted
        return true;
    }
    else if (filterConfig.usernames.mode === 'all') {
        // All usernames are blacklisted
        return false;
    }
    else if (filterConfig.usernames.mode === 'list') {
        // Check if username is in blacklist
        return !filterConfig.usernames.blacklist.includes(username);
    }
    return true; // Default allow if mode is invalid
}

/**
 * Save email data to Google Sheets via Apps Script Web App
 * @param {Object} processed - processed email data
 * @param {Object} original - original raw json from Postmark
 * @returns {Promise<boolean>} - True if saved successfully, false otherwise
 */
//future: add timeouts to async function
async function saveToGoogleSheets({ processed, original }) {
    try {
        const moderationResult = await checkContentModeration(processed);
        console.log('Moderation result:', moderationResult);

        const rawScores = moderationResult.text.categoryScores || {};
        const compactScores = JSON.stringify(rawScores, null, 0);
        const rawJson = JSON.stringify(original); // Use original Postmark data here

        // Add sanitizeForSheets function
        function sanitizeForSheets(value) {
            if (typeof value !== 'string') return '';
            // Remove control characters and other potentially harmful content
            return value
                .replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '')
                .substring(0, 50000); // Google Sheets cell limit
        }

        const isJsonTooLong = rawJson.length > 50000;

        const combinedData = {
            postmarkJSON: original,
            moderationResults: {
                text: moderationResult.text,
                images: moderationResult.images,
                overallPassed: moderationResult.overallPassed,
                summary: moderationResult.summary
            },
            timestamp: new Date().toISOString()
        };

        const isAllowed = await processEmail(processed);

        const dataToSave = [
            new Date().toLocaleString('en-US', { hour12: false }),
            sanitizeForSheets(String(processed.From || 'N/A')),
            sanitizeForSheets(String(processed.Subject || 'N/A')),
            sanitizeForSheets(String(processed.TextBody || 'N/A')),
            processed.HtmlBody ? 'Yes' : 'No',
            String(processed.Attachments?.length || 0),
            sanitizeForSheets(String(compactScores || '{}')),
            sanitizeForSheets(rawJson), // Now using original Postmark JSON
            String(isJsonTooLong),
            sanitizeForSheets(JSON.stringify(combinedData)),
            String(isAllowed)
        ];

        // Replace hardcoded URL with environment variable
        if (!process.env.GOOGLE_SCRIPT_URL) {
            throw new Error('GOOGLE_SCRIPT_URL environment variable is not set');
        }

        if (dataToSave.length !== 11) { // Updated length check to 11
            throw new Error(`Malformed row length: expected 11, got ${dataToSave.length}`);
        }

        const response = await fetch(process.env.GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: dataToSave })
        });

        const result = await response.json();
        console.log("Apps Script Response:", JSON.stringify(result, null, 2));

        if (result.status === 'success') {
            console.log('Email data saved to Google Sheets');
        } else {
            console.error('Failed to save to Google Sheets:', result.message);
            return false;
        }

        // After successful save to sheets, combine and post data
        
 
        // Post the combined data to CRUD server
        try {
            if (!process.env.CRUD_SERVER_URL) {
                throw new Error('CRUD_SERVER_URL environment variable is not set');
            }
            
            const response = await fetch(process.env.CRUD_SERVER_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(combinedData)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            console.log('Combined data successfully posted to CRUD server');
        } catch (postError) {
            console.error('Error posting combined data to CRUD server:', postError);
            // Don't throw error here to ensure Google Sheets operation isn't affected
        }

        return true;
    } catch (error) {
        console.error('Error in saveToGoogleSheets:', error);
        return false;
    }
}

/**
 * Example usage with Postmark webhook handler
 */
//future: add timeouts to async function
async function handlePostmarkWebhook(req, res) {
    try {
        console.log('\n=== START OF REQUEST PROCESSING ===');
        console.log('1. Raw request body:', JSON.stringify(req.body, null, 2));
        
        // Extract email data from MessageDetails
        const emailData = req.body?.MessageDetails || req.body;
        console.log('2. Extracted email data:', JSON.stringify(emailData, null, 2));
        
        // Ensure the data is properly structured
        const processedData = {
            From: emailData.From,
            Subject: emailData.Subject,
            TextBody: emailData.TextBody || '',
            HtmlBody: emailData.HtmlBody || '',
            Attachments: emailData.Attachments || []
        };
        
        console.log('3. Processed data structure:', {
            From: processedData.From,
            TextLength: processedData.TextBody?.length || 0,
            HtmlLength: processedData.HtmlBody?.length || 0,
            Subject: processedData.Subject
        });

        const isAllowed = await processEmail(processedData);

        const saveResult = await saveToGoogleSheets({
            processed: processedData,
            original: emailData  // This is the original Postmark data
        });
        
        if (isAllowed) {
            console.log('4. Email processed and saved:', {
                from: processedData.From,
                allowed: isAllowed,
                saved: saveResult
            });
            res.json({ 
                success: true, 
                allowed: true,
                savedToSheets: saveResult 
            });
        } else {
            console.log('4. Email blocked but saved:', {
                from: processedData.From,
                allowed: isAllowed,
                saved: saveResult
            });
            res.json({ 
                success: true, 
                allowed: false,
                savedToSheets: saveResult 
            });
        }
    } catch (error) {
        console.error('Webhook handler error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
}

module.exports = {
    processEmail,
    checkAttachmentCount,
    filterConfig,
    checkContentModeration,
    handlePostmarkWebhook  // Add this line
};