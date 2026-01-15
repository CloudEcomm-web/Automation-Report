// Vercel Serverless Function
// Deploy to: api/scrape.js

const { AnchantoScraper } = require('../scraper');

module.exports = async function handler(req, res) {
  // Optional: Protect endpoint with secret key
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const scraper = new AnchantoScraper();

  try {
    console.log('Starting scrape job...');

    // Get credentials from environment
    const email = process.env.ANCHANTO_EMAIL;
    const password = process.env.ANCHANTO_PASSWORD;
    const gdriveFolderLink = process.env.GDRIVE_FOLDER_LINK;

    if (!email || !password) {
      return res.status(500).json({ 
        error: 'Missing credentials',
        message: 'ANCHANTO_EMAIL and ANCHANTO_PASSWORD must be set'
      });
    }

    // Login
    await scraper.login(email, password);

    // Scrape data
    const data = await scraper.scrape();

    if (!data || data.rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No data found to scrape',
        rowCount: 0,
        duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
      });
    }

    // Upload to Google Drive if configured
    let uploadResult = null;
    if (gdriveFolderLink && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      const folderId = scraper.extractFolderIdFromLink(gdriveFolderLink);
      if (folderId) {
        uploadResult = await scraper.uploadToGoogleDrive(
          data, 
          'unassigned_picking_lines.csv', 
          folderId, 
          true
        );
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    return res.status(200).json({
      success: true,
      rowCount: data.count,
      pagesScraped: data.totalPages,
      duplicatesRemoved: data.duplicatesRemoved,
      uploaded: uploadResult ? true : false,
      fileId: uploadResult?.id || null,
      duration: `${duration}s`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Scrape error:', error);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
    });
  }
};

// Vercel config - extend timeout
module.exports.config = {
  maxDuration: 60 // seconds (Pro plan allows up to 300)
};