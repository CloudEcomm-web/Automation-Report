require('dotenv').config();
const { spawn } = require('child_process');
const cron = require('node-cron');

class ScraperScheduler {
  constructor() {
    this.isRunning = false;
    this.runCount = 0;
    this.lastRunTime = null;
    this.lastRunStatus = null;
  }

  /**
   * Run the scraper script
   */
  async runScraper() {
    if (this.isRunning) {
      console.log('⚠ Scraper is already running, skipping this execution...');
      return;
    }

    this.isRunning = true;
    this.runCount++;
    const startTime = new Date();
    
    console.log('\n' + '='.repeat(80));
    console.log(`🤖 STARTING SCRAPER RUN #${this.runCount}`);
    console.log(`⏰ Time: ${startTime.toLocaleString('en-US', { timeZone: 'Asia/Manila' })}`);
    console.log('='.repeat(80) + '\n');

    return new Promise((resolve) => {
      // Spawn the scraper process
      const scraperProcess = spawn('node', ['scraper.js'], {
        stdio: 'inherit', // This will show the scraper's console output
        shell: true
      });

      scraperProcess.on('close', (code) => {
        const endTime = new Date();
        const duration = ((endTime - startTime) / 1000).toFixed(2);
        
        this.isRunning = false;
        this.lastRunTime = startTime;
        this.lastRunStatus = code === 0 ? 'SUCCESS' : 'FAILED';

        console.log('\n' + '='.repeat(80));
        if (code === 0) {
          console.log(`✅ SCRAPER RUN #${this.runCount} COMPLETED SUCCESSFULLY`);
        } else {
          console.log(`❌ SCRAPER RUN #${this.runCount} FAILED (Exit code: ${code})`);
        }
        console.log(`⏱️  Duration: ${duration} seconds`);
        console.log(`⏰ Finished: ${endTime.toLocaleString('en-US', { timeZone: 'Asia/Manila' })}`);
        console.log('='.repeat(80) + '\n');

        resolve(code);
      });

      scraperProcess.on('error', (error) => {
        console.error('❌ Error spawning scraper process:', error.message);
        this.isRunning = false;
        this.lastRunStatus = 'ERROR';
        resolve(1);
      });
    });
  }

  /**
   * Print scheduler status
   */
  printStatus() {
    const now = new Date();
    console.log('\n' + '─'.repeat(80));
    console.log('📊 SCHEDULER STATUS');
    console.log('─'.repeat(80));
    console.log(`Current Time: ${now.toLocaleString('en-US', { timeZone: 'Asia/Manila' })}`);
    console.log(`Total Runs: ${this.runCount}`);
    console.log(`Last Run: ${this.lastRunTime ? this.lastRunTime.toLocaleString('en-US', { timeZone: 'Asia/Manila' }) : 'N/A'}`);
    console.log(`Last Status: ${this.lastRunStatus || 'N/A'}`);
    console.log(`Currently Running: ${this.isRunning ? 'Yes' : 'No'}`);
    console.log('─'.repeat(80) + '\n');
  }

  /**
   * Start the scheduler
   */
  start() {
    console.log('\n' + '█'.repeat(80));
    console.log('🚀 ANCHANTO SCRAPER SCHEDULER STARTED');
    console.log('█'.repeat(80));
    console.log('\n📅 Schedule: Every hour from 6:00 AM to 6:00 AM (24 hours)');
    console.log('🕐 Runs at: 6:00, 7:00, 8:00, 9:00, 10:00, 11:00, 12:00,');
    console.log('           13:00, 14:00, 15:00, 16:00, 17:00, 18:00,');
    console.log('           19:00, 20:00, 21:00, 22:00, 23:00, 0:00,');
    console.log('           1:00, 2:00, 3:00, 4:00, 5:00, 6:00');
    console.log('\n⌨️  Press Ctrl+C to stop the scheduler\n');

    // Run immediately on start
    console.log('🔄 Running initial scrape...\n');
    this.runScraper();

    // Schedule to run every hour at minute 0
    // Cron format: minute hour day month day-of-week
    // '0 * * * *' means: at minute 0 of every hour
    const cronSchedule = '0 * * * *';
    
    cron.schedule(cronSchedule, () => {
      console.log('\n⏰ Scheduled run triggered!');
      this.runScraper();
    }, {
      timezone: 'Asia/Manila'
    });

    // Print status every 30 minutes
    cron.schedule('*/60 * * * *', () => {
      if (!this.isRunning) {
        this.printStatus();
      }
    }, {
      timezone: 'Asia/Manila'
    });

    console.log('✅ Scheduler is now active and waiting for scheduled times...\n');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n' + '█'.repeat(80));
  console.log('🛑 SCHEDULER SHUTDOWN REQUESTED');
  console.log('█'.repeat(80));
  console.log('\n👋 Shutting down gracefully...');
  console.log('⏳ Please wait for any running scraper to complete...\n');
  
  setTimeout(() => {
    console.log('✅ Scheduler stopped successfully!\n');
    process.exit(0);
  }, 2000);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Received SIGTERM signal, shutting down...\n');
  process.exit(0);
});

// Start the scheduler
const scheduler = new ScraperScheduler();
scheduler.start();