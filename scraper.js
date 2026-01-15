require('dotenv').config();
const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const fs = require('fs');
const { google } = require('googleapis');
const { Readable } = require('stream');

class AnchantoScraper {
  constructor() {
    this.cookieJar = new tough.CookieJar();
    this.client = wrapper(axios.create({
      jar: this.cookieJar,
      withCredentials: true,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    }));
    this.baseUrl = 'https://ewms.anchanto.com';
    this.csrfToken = null;
    this.headers = null;        // Headers for export (excluding Action)
    this.allHeaders = null;     // All headers including Action
    this.skipColumnIndexes = new Set(); // Column indexes to skip
  }

  /**
   * Extract CSRF token from HTML
   */
  extractCsrfToken(html) {
    const $ = cheerio.load(html);
    return $('meta[name="csrf-token"]').attr('content') || 
           $('input[name="authenticity_token"]').val();
  }

  /**
   * Login to Anchanto
   */
  async login(userEmail, userPassword) {
    console.log('Logging in with email:', userEmail);
    
    try {
      console.log('Fetching login page...');
      const loginPageResponse = await this.client.get(`${this.baseUrl}/login`);
      
      this.csrfToken = this.extractCsrfToken(loginPageResponse.data);
      console.log(this.csrfToken ? '✓ CSRF token found' : '⚠ No CSRF token found');

      console.log('Submitting login credentials...');
      
      const loginData = new URLSearchParams({
        'user[email]': userEmail,
        'user[password]': userPassword,
        'commit': 'Sign In'
      });
      
      if (this.csrfToken) {
        loginData.append('authenticity_token', this.csrfToken);
      }

      await this.client.post(`${this.baseUrl}/login`, loginData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': this.baseUrl,
          'Referer': `${this.baseUrl}/login`,
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 500
      });

      // Verify login
      const checkResponse = await this.client.get(`${this.baseUrl}/order_pickup_lists`, {
        validateStatus: (status) => status < 500
      });
      
      if (checkResponse.request?.path?.includes('/login')) {
        throw new Error('Login failed - invalid credentials');
      }

      console.log('✓ Login successful!');
      return true;

    } catch (error) {
      console.error('Login error:', error.message);
      throw error;
    }
  }

  /**
   * Get column headers from HTML page (like old Puppeteer version)
   */
  async fetchHeaders() {
    console.log('Fetching column headers...');
    
    const response = await this.client.get(`${this.baseUrl}/order_pickup_lists?state=unassigned`);
    const $ = cheerio.load(response.data);
    
    const allHeaders = [];
    const exportHeaders = [];
    const skipIndexes = new Set();
    
    $('table thead th').each((index, el) => {
      const text = $(el).text().trim();
      allHeaders.push(text);
      
      // Skip Action/Actions/Select columns (UI-only columns)
      const lowerText = text.toLowerCase();
      if (lowerText === 'action' || lowerText === 'actions' || lowerText === 'select' || lowerText === '') {
        skipIndexes.add(index);
        console.log(`  - Skipping column ${index}: "${text}" (UI-only)`);
      } else {
        exportHeaders.push(text);
      }
    });
    
    this.allHeaders = allHeaders;
    this.headers = exportHeaders;
    this.skipColumnIndexes = skipIndexes;
    
    console.log(`✓ Found ${allHeaders.length} total columns, exporting ${exportHeaders.length}`);
    console.log('Export columns:', exportHeaders.join(', '));
    
    return exportHeaders;
  }

  /**
   * Clean HTML from cell values (to match Puppeteer's textContent behavior)
   */
  cleanValue(value) {
    if (value === null || value === undefined) return '';
    
    let str = String(value);
    
    // Remove all HTML tags
    str = str.replace(/<[^>]*>/g, ' ');
    
    // Decode common HTML entities
    str = str.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&nbsp;/g, ' ')
             .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
    
    // Normalize whitespace (multiple spaces to single, trim)
    str = str.replace(/\s+/g, ' ').trim();
    
    return str;
  }

  /**
   * Scrape using DataTables JSON API
   */
  async scrapeUnassignedPickingLines() {
    console.log('Navigating to unassigned picking lines...');
    
    try {
      // First get headers from HTML page
      if (!this.headers) {
        await this.fetchHeaders();
      }

      let allRows = [];
      let offset = 0;
      const pageSize = 500;
      let totalRecords = null;
      let pageCount = 0;

      console.log(`Starting to scrape with ${pageSize} entries per page...`);

      while (true) {
        pageCount++;
        console.log(`\nFetching page ${pageCount} (offset: ${offset})...`);

        // DataTables server-side parameters
        const params = new URLSearchParams({
          'state': 'unassigned',
          'sEcho': pageCount.toString(),
          'iDisplayStart': offset.toString(),
          'iDisplayLength': pageSize.toString(),
        });

        const response = await this.client.get(
          `${this.baseUrl}/order_pickup_lists.json?${params.toString()}`,
          {
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            }
          }
        );

        const data = response.data;

        // Get total records on first request
        if (totalRecords === null) {
          totalRecords = data.iTotalRecords || data.iTotalDisplayRecords || 0;
          console.log(`Total records: ${totalRecords}`);
        }

        // aaData contains the rows
        const rows = data.aaData || [];
        
        if (rows.length === 0) {
          console.log('No more data, stopping...');
          break;
        }

        console.log(`Received ${rows.length} rows`);

        // Convert array-of-arrays to array-of-objects (matching old format)
        for (const row of rows) {
          const rowObj = {};
          
          if (Array.isArray(row)) {
            // Process each cell, skipping Action columns
            row.forEach((cellValue, colIndex) => {
              // Skip UI-only columns
              if (this.skipColumnIndexes.has(colIndex)) {
                return;
              }
              
              const header = this.allHeaders[colIndex];
              if (header) {
                rowObj[header] = this.cleanValue(cellValue);
              }
            });
          }
          
          // Only add row if it has data
          if (Object.keys(rowObj).length > 0) {
            allRows.push(rowObj);
          }
        }

        console.log(`Total collected: ${allRows.length}/${totalRecords}`);

        // Check if done
        if (allRows.length >= totalRecords) {
          console.log('All records fetched!');
          break;
        }

        offset += rows.length;

        // Safety limit
        if (pageCount > 100) {
          console.log('⚠ Reached page limit (100), stopping...');
          break;
        }

        // Small delay to be respectful to server
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`\n✓ Scraping complete! Total pages: ${pageCount}, Total rows: ${allRows.length}`);

      return {
        headers: this.headers,
        rows: allRows,
        count: allRows.length,
        totalPages: pageCount,
        duplicatesRemoved: 0
      };

    } catch (error) {
      console.error('Scraping error:', error.message);
      throw error;
    }
  }

  /**
   * Main scrape method
   */
  async scrape() {
    return await this.scrapeUnassignedPickingLines();
  }

  /**
   * Export to JSON (matching old format)
   */
  async exportToJSON(data, filename = 'unassigned_picking_lines.json') {
    if (data && data.rows.length > 0) {
      fs.writeFileSync(filename, JSON.stringify(data, null, 2));
      console.log(`✓ Data exported to ${filename}`);
      console.log(`  - Total unique rows: ${data.count}`);
      console.log(`  - Total pages scraped: ${data.totalPages}`);
    } else {
      console.log('No data to export');
    }
  }

  /**
   * Export to CSV (matching old Puppeteer format exactly)
   */
  async exportToCSV(data, filename = 'unassigned_picking_lines.csv') {
    if (!data || data.rows.length === 0) {
      console.log('No data to export');
      return;
    }

    // Find Order# column index for special formatting
    const orderColumnIndex = data.headers.findIndex(h => 
      h === 'Order#' || 
      (h.toLowerCase().includes('order') && h.includes('#'))
    );

    // Build CSV exactly like old version
    const headers = data.headers.join(',');
    const rows = data.rows.map(row => {
      return data.headers.map((header, index) => {
        const value = row[header] || '';
        
        // Format Order# as text to preserve leading zeros (="value")
        if (index === orderColumnIndex && value) {
          return `="${value.replace(/"/g, '""')}"`;
        }
        
        // Standard CSV quoting
        return `"${value.replace(/"/g, '""')}"`;
      }).join(',');
    });

    const csv = [headers, ...rows].join('\n');
    
    fs.writeFileSync(filename, csv);
    console.log(`✓ Data exported to ${filename}`);
    console.log(`  - Total unique rows: ${data.count}`);
    console.log(`  - Total pages scraped: ${data.totalPages}`);
    console.log(`  - Order# column formatted as text`);
  }

  /**
   * Convert data to CSV stream for Google Drive upload
   */
  csvToStream(data) {
    const orderColumnIndex = data.headers.findIndex(h => 
      h === 'Order#' || (h.toLowerCase().includes('order') && h.includes('#'))
    );

    const headers = data.headers.join(',');
    const rows = data.rows.map(row => {
      return data.headers.map((header, index) => {
        const value = row[header] || '';
        if (index === orderColumnIndex && value) {
          return `="${value.replace(/"/g, '""')}"`;
        }
        return `"${value.replace(/"/g, '""')}"`;
      }).join(',');
    });

    const csv = [headers, ...rows].join('\n');
    return Readable.from([csv]);
  }

  /**
   * Extract folder ID from Google Drive link
   */
  extractFolderIdFromLink(link) {
    const match = link.match(/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Trigger Google Apps Script webhook
   */
  async triggerGoogleScript(data = {}) {
    const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
    
    if (!scriptUrl) {
      console.log('⚠ Google Script URL not configured, skipping trigger');
      return null;
    }

    try {
      console.log('\nTriggering Google Apps Script...');
      console.log(`  - URL: ${scriptUrl.substring(0, 50)}...`);
      
      // Send POST request with data
      const response = await axios.post(scriptUrl, {
        action: 'scrapeComplete',
        timestamp: new Date().toISOString(),
        rowCount: data.rowCount || 0,
        source: 'anchanto-scraper',
        ...data
      }, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 30000,
        maxRedirects: 5,
      });

      console.log('✓ Google Script triggered successfully!');
      console.log(`  - Response: ${JSON.stringify(response.data).substring(0, 100)}`);
      
      return response.data;
    } catch (error) {
      // Google Scripts often redirect, try GET as fallback
      try {
        console.log('  - POST failed, trying GET request...');
        const params = new URLSearchParams({
          action: 'scrapeComplete',
          timestamp: new Date().toISOString(),
          rowCount: data.rowCount || 0,
        });
        
        const response = await axios.get(`${scriptUrl}?${params.toString()}`, {
          timeout: 30000,
          maxRedirects: 5,
        });
        
        console.log('✓ Google Script triggered successfully (GET)!');
        return response.data;
      } catch (getError) {
        console.error('⚠ Error triggering Google Script:', error.message);
        return null;
      }
    }
  }

  /**
   * Search for existing file with the same name in the folder
   */
  async findExistingFile(drive, filename, folderId) {
    try {
      const escapedFilename = filename.replace(/'/g, "\\'");
      
      const response = await drive.files.list({
        q: `name='${escapedFilename}' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, createdTime, modifiedTime)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (response.data.files && response.data.files.length > 0) {
        console.log(`  - Found ${response.data.files.length} existing file(s) with name: ${filename}`);
        return response.data.files;
      }
      
      return null;
    } catch (error) {
      console.error('Error searching for existing file:', error.message);
      return null;
    }
  }

  /**
   * Delete an existing file from Google Drive
   */
  async deleteFile(drive, fileId, fileName) {
    try {
      await drive.files.delete({
        fileId: fileId,
        supportsAllDrives: true,
      });
      
      console.log(`  ✓ Deleted old file: ${fileName} (ID: ${fileId})`);
      return true;
    } catch (error) {
      console.error(`  ✗ Error deleting file ${fileName}: ${error.message}`);
      
      // Try to trash instead
      try {
        console.log(`  - Attempting to trash file instead...`);
        await drive.files.update({
          fileId: fileId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });
        console.log(`  ✓ Moved file to trash: ${fileName} (ID: ${fileId})`);
        return true;
      } catch (trashError) {
        console.error(`  ✗ Could not trash file either: ${trashError.message}`);
        return false;
      }
    }
  }

  /**
   * Upload to Google Drive
   */
  async uploadToGoogleDrive(data, filename, folderId, replaceExisting = true) {
    try {
      console.log('\nUploading to Google Drive...');
      console.log(`  - Target folder ID: ${folderId}`);
      console.log(`  - Filename: ${filename}`);
      console.log(`  - Replace existing: ${replaceExisting ? 'Yes' : 'No'}`);

      // Authenticate with Google Drive API
      let auth;
      
      if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
        auth = new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
          scopes: ['https://www.googleapis.com/auth/drive'],
        });
      } else if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ['https://www.googleapis.com/auth/drive'],
        });
      } else {
        throw new Error('No Google credentials configured');
      }

      const drive = google.drive({ version: 'v3', auth });

      // Delete existing file if needed
      if (replaceExisting) {
        console.log(`  - Searching for existing files with name: ${filename}`);
        const existingFiles = await this.findExistingFile(drive, filename, folderId);
        
        if (existingFiles && existingFiles.length > 0) {
          console.log(`  - Deleting ${existingFiles.length} existing file(s)...`);
          for (const file of existingFiles) {
            await this.deleteFile(drive, file.id, file.name);
          }
        } else {
          console.log(`  - No existing file found with name: ${filename}`);
        }
      }

      // Upload the new file
      console.log(`  - Uploading new file...`);
      const fileMetadata = {
        name: filename,
        parents: [folderId],
      };

      const media = {
        mimeType: 'text/csv',
        body: this.csvToStream(data),
      };

      const response = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, createdTime',
        supportsAllDrives: true,
      });

      console.log(`✓ File uploaded successfully to Google Drive!`);
      console.log(`  - File ID: ${response.data.id}`);
      console.log(`  - File Name: ${response.data.name}`);
      console.log(`  - Created: ${response.data.createdTime}`);
      if (response.data.webViewLink) {
        console.log(`  - View Link: ${response.data.webViewLink}`);
      }
      
      return response.data;
    } catch (error) {
      console.error('Error uploading to Google Drive:', error.message);
      
      if (error.message.includes('404') || error.message.includes('not found')) {
        console.error('\n⚠ Folder not found or access denied.');
      } else if (error.message.includes('keyFile') || error.message.includes('ENOENT')) {
        console.error('\n⚠ Service account key file error.');
      } else if (error.message.includes('quota') || error.message.includes('storage')) {
        console.error('\n⚠ Storage quota issue - use a Shared Drive instead.');
      }
      
      throw error;
    }
  }
}

// Main function
async function main() {
  const scraper = new AnchantoScraper();

  try {
    const myEmail = process.env.ANCHANTO_EMAIL;
    const myPassword = process.env.ANCHANTO_PASSWORD;
    const gdriveFolderLink = process.env.GDRIVE_FOLDER_LINK;

    if (!myEmail || !myPassword) {
      throw new Error('Missing credentials! Please set ANCHANTO_EMAIL and ANCHANTO_PASSWORD in your .env file');
    }

    console.log('='.repeat(60));
    console.log('ANCHANTO SCRAPER - HTTP Version (No Puppeteer)');
    console.log('='.repeat(60));

    // Login
    await scraper.login(myEmail, myPassword);

    // Scrape ALL unassigned picking lines
    const data = await scraper.scrape();

    if (data && data.rows.length > 0) {
      console.log('\n' + '='.repeat(60));
      console.log('SCRAPING SUMMARY');
      console.log('='.repeat(60));
      console.log('Headers:', data.headers.join(', '));
      console.log('Total rows scraped:', data.count);
      console.log('Total pages processed:', data.totalPages);
      console.log('\nFirst row sample:');
      console.log(JSON.stringify(data.rows[0], null, 2));

      // Export to both JSON and CSV
      await scraper.exportToJSON(data);
      const csvFilename = 'unassigned_picking_lines.csv';
      await scraper.exportToCSV(data, csvFilename);
      
      console.log('\n✓ All data successfully exported!');

      // Upload to Google Drive if configured
      if (gdriveFolderLink && (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_SERVICE_ACCOUNT_KEY)) {
        const folderId = scraper.extractFolderIdFromLink(gdriveFolderLink);
        if (folderId) {
          console.log('\n' + '='.repeat(60));
          console.log('GOOGLE DRIVE UPLOAD');
          console.log('='.repeat(60));
          await scraper.uploadToGoogleDrive(data, csvFilename, folderId, true);
        } else {
          console.log('\n⚠ Could not extract folder ID from Google Drive link');
          console.log('   Link format should be: https://drive.google.com/drive/folders/FOLDER_ID');
        }
      } else {
        console.log('\n⚠ Google Drive upload skipped (not configured)');
        if (!gdriveFolderLink) {
          console.log('  - Set GDRIVE_FOLDER_LINK in .env to enable upload');
        }
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
          console.log('  - Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env to enable upload');
        }
      }

      // Trigger Google Apps Script if configured
      if (process.env.GOOGLE_SCRIPT_URL) {
        console.log('\n' + '='.repeat(60));
        console.log('GOOGLE APPS SCRIPT TRIGGER');
        console.log('='.repeat(60));
        await scraper.triggerGoogleScript({
          rowCount: data.count,
          pagesScraped: data.totalPages,
          headers: data.headers,
        });
      }
    } else {
      console.log('\n⚠ No data was scraped');
    }

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Export for module use (Vercel, etc.)
module.exports = { AnchantoScraper };

// Run if executed directly
if (require.main === module) {
  main();
}
