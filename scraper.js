require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const { google } = require('googleapis');

class AnchantoScraper {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async initialize(headless = false) {
    console.log('Initializing browser...');
    this.browser = await puppeteer.launch({
      headless: headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1366, height: 768 });
  }

  async login(userEmail, userPassword) {
    console.log('Logging in with email:', userEmail);
    
    try {
      console.log('Navigating to login page...');
      await this.page.goto('https://ewms.anchanto.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('Page loaded, looking for email input...');

      const emailInput = await this.page.waitForSelector('input#user_email[type="email"]', { 
        visible: true,
        timeout: 15000 
      });

      console.log('Email input found!');

      const passwordInput = await this.page.waitForSelector('input#user_password[type="password"]', { 
        visible: true,
        timeout: 15000 
      });

      console.log('Password input found!');

      await emailInput.click({ clickCount: 3 });
      await this.page.keyboard.press('Delete');
      await emailInput.type(userEmail, { delay: 100 });

      await passwordInput.click({ clickCount: 3 });
      await this.page.keyboard.press('Delete');
      await passwordInput.type(userPassword, { delay: 100 });

      console.log('Credentials filled, submitting...');

      const submitButton = await this.page.waitForSelector('input[type="submit"][value="Sign In"]', {
        visible: true,
        timeout: 10000
      });

      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        submitButton.click()
      ]);

      console.log('Login successful!');
      await this.page.screenshot({ path: 'after_login.png' });
    } catch (error) {
      console.error('Login error:', error.message);
      await this.page.screenshot({ path: 'login_error.png', fullPage: true });
      throw error;
    }
  }

  async setEntriesPerPage(count = 500) {
    console.log(`Setting entries per page to ${count}...`);
    
    try {
      await this.page.waitForSelector('select', { timeout: 10000 });
      
      const dropdownChanged = await this.page.evaluate((count) => {
        const selects = document.querySelectorAll('select');
        for (let select of selects) {
          const options = Array.from(select.options).map(opt => opt.value);
          if (options.includes('10') && options.includes('500')) {
            select.value = count.toString();
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, count);

      if (dropdownChanged) {
        console.log('Dropdown changed, waiting for table to reload...');
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {
          console.log('Network idle timeout, continuing anyway...');
        });
        
        await this.page.waitForSelector('table tbody tr', { timeout: 15000 });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const rowCount = await this.page.evaluate(() => {
          return document.querySelectorAll('table tbody tr').length;
        });
        
        console.log(`✓ Table reloaded with ${rowCount} visible rows`);
        console.log(`Successfully set to ${count} entries per page`);
      } else {
        console.log('Could not find entries per page dropdown');
      }
    } catch (error) {
      console.error('Error setting entries per page:', error.message);
    }
  }

  async getTotalEntries() {
    try {
      const totalText = await this.page.evaluate(() => {
        const elements = document.querySelectorAll('*');
        for (let el of elements) {
          const text = el.textContent;
          if (text && text.includes('Showing') && text.includes('entries')) {
            return text;
          }
        }
        return null;
      });

      if (totalText) {
        const match = totalText.match(/of\s+(\d+)\s+entries/i);
        if (match) {
          const total = parseInt(match[1]);
          console.log(`Total entries found: ${total}`);
          return total;
        }
      }
      
      console.log('Could not determine total entries from text');
      return null;
    } catch (error) {
      console.error('Error getting total entries:', error.message);
      return null;
    }
  }

  async scrapeCurrentPage() {
    console.log('Extracting data from current page...');

    const data = await this.page.evaluate(() => {
      const table = document.querySelector('table');
      if (!table) return null;

      const headers = [];
      const headerCells = table.querySelectorAll('thead th');
      headerCells.forEach(cell => {
        headers.push(cell.textContent.trim());
      });

      const rows = [];
      const tableRows = table.querySelectorAll('tbody tr');
      
      tableRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        const rowData = {};
        
        cells.forEach((cell, index) => {
          const header = headers[index] || `Column_${index}`;
          rowData[header] = cell.textContent.trim();
        });
        
        if (Object.keys(rowData).length > 0) {
          rows.push(rowData);
        }
      });

      return {
        headers: headers,
        rows: rows
      };
    });

    return data;
  }

  async hasNextPage() {
    try {
      const hasNext = await this.page.evaluate(() => {
        const nextButtons = Array.from(document.querySelectorAll('a, button'));
        const nextButton = nextButtons.find(btn => 
          btn.textContent.trim().toLowerCase() === 'next' && 
          !btn.classList.contains('disabled') &&
          !btn.hasAttribute('disabled')
        );
        return nextButton !== undefined;
      });
      
      return hasNext;
    } catch (error) {
      console.error('Error checking for next page:', error.message);
      return false;
    }
  }

  async goToNextPage() {
    try {
      console.log('Navigating to next page...');
      
      const clicked = await this.page.evaluate(() => {
        const nextButtons = Array.from(document.querySelectorAll('a, button'));
        const nextButton = nextButtons.find(btn => 
          btn.textContent.trim().toLowerCase() === 'next' &&
          !btn.classList.contains('disabled') &&
          !btn.hasAttribute('disabled')
        );
        
        if (nextButton) {
          nextButton.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {
          console.log('Network idle timeout during navigation, continuing...');
        });
        
        await this.page.waitForSelector('table tbody tr', { timeout: 15000 });
        
        await new Promise(resolve => setTimeout(resolve, 1500));
        
        const rowCount = await this.page.evaluate(() => {
          return document.querySelectorAll('table tbody tr').length;
        });
        
        console.log(`✓ Successfully navigated to next page (${rowCount} rows visible)`);
        return true;
      } else {
        console.log('Next button not found or disabled');
        return false;
      }
    } catch (error) {
      console.error('Error going to next page:', error.message);
      return false;
    }
  }

  getRowIdentifier(row, headers) {
    const snColumn = headers.find(h => h === 'S/N' || h.toLowerCase().includes('s/n'));
    const awbColumn = headers.find(h => h === 'AWB' || h.toLowerCase().includes('awb'));
    const trackingColumn = headers.find(h => h === 'Tracking #' || h.toLowerCase().includes('tracking'));
    
    if (snColumn && row[snColumn]) {
      return `sn_${row[snColumn]}`;
    } else if (awbColumn && row[awbColumn]) {
      return `awb_${row[awbColumn]}`;
    } else if (trackingColumn && row[trackingColumn]) {
      return `tracking_${row[trackingColumn]}`;
    } else {
      return Object.values(row).join('|');
    }
  }

  async scrapeUnassignedPickingLines() {
    console.log('Navigating to unassigned picking lines...');
    
    try {
      await this.page.goto('https://ewms.anchanto.com/order_pickup_lists?state=unassigned', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      console.log('Page loaded, verifying we are on Unassigned tab...');
      
      const isCorrectTab = await this.page.evaluate(() => {
        const tabs = document.querySelectorAll('a, button, div');
        for (let tab of tabs) {
          if (tab.textContent.trim() === 'Unassigned' && 
              (tab.classList.contains('active') || 
               tab.closest('.active') || 
               window.location.href.includes('state=unassigned'))) {
            return true;
          }
        }
        return window.location.href.includes('state=unassigned');
      });

      if (!isCorrectTab) {
        console.log('⚠ Warning: May not be on Unassigned tab, but URL contains state=unassigned');
      } else {
        console.log('✓ Confirmed on Unassigned tab');
      }

      await this.page.waitForSelector('table', { timeout: 15000 });
      await this.setEntriesPerPage(500);

      const totalEntries = await this.getTotalEntries();
      console.log(`Starting to scrape${totalEntries ? ` ${totalEntries} total entries` : ''}...`);

      let allRows = [];
      let allHeaders = null;
      let pageCount = 0;
      let hasMore = true;
      let seenIds = new Set();
      let duplicateCount = 0;
      let previousPageRowCount = -1;

      while (hasMore) {
        pageCount++;
        console.log(`\nScraping page ${pageCount}...`);

        const currentUrl = this.page.url();
        if (!currentUrl.includes('state=unassigned')) {
          console.log('⚠ Warning: URL changed, no longer on unassigned tab!');
          console.log('Current URL:', currentUrl);
          console.log('Stopping scraping to prevent collecting wrong data...');
          break;
        }

        const pageData = await this.scrapeCurrentPage();
        
        if (pageData && pageData.rows.length > 0) {
          if (!allHeaders) {
            allHeaders = pageData.headers;
          }
          
          console.log(`Found ${pageData.rows.length} rows on page ${pageCount}`);
          
          let newRowsCount = 0;
          let pageHasDuplicates = false;
          
          for (const row of pageData.rows) {
            const rowId = this.getRowIdentifier(row, allHeaders);
            
            if (!seenIds.has(rowId)) {
              seenIds.add(rowId);
              allRows.push(row);
              newRowsCount++;
            } else {
              duplicateCount++;
              pageHasDuplicates = true;
            }
          }
          
          console.log(`Added ${newRowsCount} new unique rows`);
          if (pageHasDuplicates) {
            console.log(`⚠ Found ${pageData.rows.length - newRowsCount} duplicate(s) on this page`);
          }
          console.log(`Total unique rows collected: ${allRows.length}`);

          if (newRowsCount === 0 && previousPageRowCount === pageData.rows.length) {
            console.log('All rows on this page are duplicates and same count as previous page. Stopping...');
            hasMore = false;
          } else {
            previousPageRowCount = pageData.rows.length;
            
            hasMore = await this.hasNextPage();
            
            if (hasMore) {
              const success = await this.goToNextPage();
              if (!success) {
                console.log('Could not navigate to next page, stopping...');
                hasMore = false;
              }
              
              await new Promise(resolve => setTimeout(resolve, 1000));
              const urlAfterNav = this.page.url();
              if (!urlAfterNav.includes('state=unassigned')) {
                console.log('⚠ Error: Navigation changed the tab! Stopping...');
                console.log('Expected state=unassigned but got:', urlAfterNav);
                hasMore = false;
              }
            } else {
              console.log('No more pages to scrape');
            }
          }
        } else {
          console.log('No data found on current page, stopping...');
          hasMore = false;
        }

        if (totalEntries && allRows.length > totalEntries * 1.5) {
          console.log('Warning: Scraped more rows than expected, stopping...');
          hasMore = false;
        }

        if (pageCount > 100) {
          console.log('Warning: Scraped more than 100 pages, stopping to prevent infinite loop...');
          hasMore = false;
        }
      }

      console.log(`\n✓ Scraping complete! Total pages: ${pageCount}, Unique rows: ${allRows.length}`);
      
      if (duplicateCount > 0) {
        console.log(`⚠ Total duplicates filtered out: ${duplicateCount}`);
      }

      if (totalEntries && allRows.length !== totalEntries) {
        console.log(`⚠ Note: Expected ${totalEntries} entries but got ${allRows.length} unique rows`);
      }

      return {
        headers: allHeaders,
        rows: allRows,
        count: allRows.length,
        totalPages: pageCount,
        duplicatesRemoved: duplicateCount
      };

    } catch (error) {
      console.error('Scraping error:', error.message);
      await this.page.screenshot({ path: 'scraping_error.png' });
      throw error;
    }
  }

  async exportToJSON(data, filename = 'unassigned_picking_lines.json') {
    if (data && data.rows.length > 0) {
      fs.writeFileSync(filename, JSON.stringify(data, null, 2));
      console.log(`✓ Data exported to ${filename}`);
      console.log(`  - Total unique rows: ${data.count}`);
      console.log(`  - Total pages scraped: ${data.totalPages}`);
      if (data.duplicatesRemoved > 0) {
        console.log(`  - Duplicates removed: ${data.duplicatesRemoved}`);
      }
    } else {
      console.log('No data to export');
    }
  }

  async exportToCSV(data, filename = 'unassigned_picking_lines.csv') {
    if (!data || data.rows.length === 0) {
      console.log('No data to export');
      return;
    }

    const orderColumnIndex = data.headers.findIndex(h => 
      h === 'Order#' || 
      h.toLowerCase().includes('order') && h.includes('#')
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
    
    fs.writeFileSync(filename, csv);
    console.log(`✓ Data exported to ${filename}`);
    console.log(`  - Total unique rows: ${data.count}`);
    console.log(`  - Total pages scraped: ${data.totalPages}`);
    if (data.duplicatesRemoved > 0) {
      console.log(`  - Duplicates removed: ${data.duplicatesRemoved}`);
    }
    console.log(`  - Order# column formatted as text`);
  }

  extractFolderIdFromLink(link) {
    // Extract folder ID from various Google Drive link formats
    // Format 1: https://drive.google.com/drive/folders/FOLDER_ID
    // Format 2: https://drive.google.com/drive/u/0/folders/FOLDER_ID
    const match = link.match(/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Search for existing file with the same name in the folder
   */
  async findExistingFile(drive, filename, folderId) {
    try {
      const response = await drive.files.list({
        q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, createdTime)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (response.data.files && response.data.files.length > 0) {
        return response.data.files[0]; // Return the first matching file
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
  async deleteFile(drive, fileId) {
    try {
      await drive.files.delete({
        fileId: fileId,
        supportsAllDrives: true,
      });
      console.log(`  ✓ Deleted old file (ID: ${fileId})`);
      return true;
    } catch (error) {
      console.error(`  ✗ Error deleting file: ${error.message}`);
      return false;
    }
  }

  async uploadToGoogleDrive(filename, folderId, replaceExisting = true) {
    try {
      console.log('\nUploading to Google Drive...');
      console.log(`  - Target folder ID: ${folderId}`);
      console.log(`  - Replace existing: ${replaceExisting ? 'Yes' : 'No'}`);

      // Authenticate with Google Drive API
      const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      });

      const drive = google.drive({ version: 'v3', auth });

      // Check if file already exists
      if (replaceExisting) {
        console.log(`  - Checking for existing file: ${filename}`);
        const existingFile = await this.findExistingFile(drive, filename, folderId);
        
        if (existingFile) {
          console.log(`  - Found existing file: ${existingFile.name} (created: ${existingFile.createdTime})`);
          console.log(`  - Deleting old file...`);
          await this.deleteFile(drive, existingFile.id);
        } else {
          console.log(`  - No existing file found`);
        }
      }

      // Upload the file with Shared Drive support
      console.log(`  - Uploading new file...`);
      const response = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [folderId],
        },
        media: {
          mimeType: 'text/csv',
          body: fs.createReadStream(filename),
        },
        supportsAllDrives: true,
      });

      console.log(`✓ File uploaded successfully to Google Drive!`);
      console.log(`  - File ID: ${response.data.id}`);
      console.log(`  - File Name: ${filename}`);
      
      return response.data;
    } catch (error) {
      console.error('Error uploading to Google Drive:', error.message);
      
      if (error.message.includes('404') || error.message.includes('not found')) {
        console.error('\n⚠ Folder not found or access denied. Make sure:');
        console.error('  1. The folder/Shared Drive exists');
        console.error('  2. Service account is added as a member:');
        console.error('     renz-paragas@decoded-tesla-465608-s9.iam.gserviceaccount.com');
        console.error('  3. Service account has "Content manager" or "Manager" permissions');
      } else if (error.message.includes('keyFile')) {
        console.error('\n⚠ Service account key file error. Make sure:');
        console.error('  1. GOOGLE_SERVICE_ACCOUNT_KEY_FILE path in .env is correct');
        console.error('  2. The JSON key file exists at that location');
      } else if (error.message.includes('quota')) {
        console.error('\n⚠ Storage quota issue detected!');
        console.error('  This error occurs because service accounts have no storage quota.');
        console.error('  Solution: Use a Shared Drive instead of "My Drive"');
      }
      
      throw error;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('Browser closed');
    }
  }
}

// Main function
async function main() {
  const scraper = new AnchantoScraper();

  try {
    // Initialize browser (set to true for headless mode)
    await scraper.initialize(false);

    // Load credentials from environment variables
    const myEmail = process.env.ANCHANTO_EMAIL;
    const myPassword = process.env.ANCHANTO_PASSWORD;
    const gdriveFolderLink = process.env.GDRIVE_FOLDER_LINK;

    // Validate credentials
    if (!myEmail || !myPassword) {
      throw new Error('Missing credentials! Please set ANCHANTO_EMAIL and ANCHANTO_PASSWORD in your .env file');
    }

    console.log('='.repeat(60));
    console.log('ANCHANTO SCRAPER - Enhanced with Pagination Support');
    console.log('='.repeat(60));

    // Login
    await scraper.login(myEmail, myPassword);

    // Scrape ALL unassigned picking lines with pagination
    const data = await scraper.scrapeUnassignedPickingLines();

    if (data) {
      console.log('\n' + '='.repeat(60));
      console.log('SCRAPING SUMMARY');
      console.log('='.repeat(60));
      console.log('Headers:', data.headers.join(', '));
      console.log('Total rows scraped:', data.count);
      console.log('Total pages processed:', data.totalPages);
      if (data.duplicatesRemoved > 0) {
        console.log('Duplicates removed:', data.duplicatesRemoved);
      }
      console.log('\nFirst row sample:');
      console.log(JSON.stringify(data.rows[0], null, 2));

      // Export to both JSON and CSV
      await scraper.exportToJSON(data);
      const csvFilename = 'unassigned_picking_lines.csv';
      await scraper.exportToCSV(data, csvFilename);
      
      console.log('\n✓ All data successfully exported!');

      // Upload to Google Drive if configured
      if (gdriveFolderLink && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
        const folderId = scraper.extractFolderIdFromLink(gdriveFolderLink);
        if (folderId) {
          console.log('\n' + '='.repeat(60));
          console.log('GOOGLE DRIVE UPLOAD');
          console.log('='.repeat(60));
          // Upload with file replacement enabled (true by default)
          await scraper.uploadToGoogleDrive(csvFilename, folderId, true);
        } else {
          console.log('\n⚠ Could not extract folder ID from Google Drive link');
          console.log('   Link format should be: https://drive.google.com/drive/folders/FOLDER_ID');
        }
      } else {
        console.log('\n⚠ Google Drive upload skipped (not configured)');
        if (!gdriveFolderLink) {
          console.log('  - Set GDRIVE_FOLDER_LINK in .env to enable upload');
        }
        if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
          console.log('  - Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env to enable upload');
        }
      }
    }

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error.stack);
  } finally {
    await scraper.close();
  }
}

// Run the scraper
main();