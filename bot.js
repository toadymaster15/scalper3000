const Discord = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

// Simple health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'Bot is running!',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', bot: client.user?.tag || 'not ready' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server running on port ${PORT}`);
});

const client = new Discord.Client({ 
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent
  ] 
});

// File paths for data storage
const DATA_DIR = path.join(__dirname, 'data');
const PRICE_HISTORY_FILE = path.join(DATA_DIR, 'price_history.json');
const TRACKED_ITEMS_FILE = path.join(DATA_DIR, 'tracked_items.json');

// ==================== STORAGE FUNCTIONS ====================

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
}

// Load data from file
async function loadData(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {}; // Return empty object if file doesn't exist
  }
}

// Save data to file
async function saveData(filePath, data) {
  try {
    await ensureDataDir();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Clean old entries (older than 30 days)
function cleanOldEntries(priceHistory) {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
  for (const url in priceHistory) {
    priceHistory[url] = priceHistory[url].filter(entry => 
      new Date(entry.timestamp).getTime() > thirtyDaysAgo
    );
    
    // Remove empty arrays
    if (priceHistory[url].length === 0) {
      delete priceHistory[url];
    }
  }
  
  return priceHistory;
}

// Save price to history
async function savePriceHistory(url, title, price, currency = 'PLN') {
  try {
    const priceHistory = await loadData(PRICE_HISTORY_FILE);
    
    if (!priceHistory[url]) {
      priceHistory[url] = [];
    }
    
    const today = new Date().toDateString();
    const existingTodayEntry = priceHistory[url].find(entry => 
      new Date(entry.timestamp).toDateString() === today
    );
    
    if (!existingTodayEntry) {
      priceHistory[url].push({
        title,
        price,
        currency,
        timestamp: new Date().toISOString()
      });
      
      // Clean old entries to keep file size manageable
      const cleanedHistory = cleanOldEntries(priceHistory);
      await saveData(PRICE_HISTORY_FILE, cleanedHistory);
    }
  } catch (error) {
    console.error('Error saving price history:', error);
  }
}

// Get price statistics for last 30 days
async function getPriceStats(url) {
  try {
    const priceHistory = await loadData(PRICE_HISTORY_FILE);
    const urlHistory = priceHistory[url] || [];
    
    if (urlHistory.length === 0) return null;
    
    const prices = urlHistory.map(entry => entry.price);
    const lowest = Math.min(...prices);
    const highest = Math.max(...prices);
    const average = prices.reduce((a, b) => a + b, 0) / prices.length;
    const latest = urlHistory[urlHistory.length - 1];
    
    return {
      lowest_price: lowest,
      highest_price: highest,
      avg_price: average.toFixed(2),
      price_checks: urlHistory.length,
      latest_price: latest.price,
      latest_check: latest.timestamp
    };
  } catch (error) {
    console.error('Error getting price stats:', error);
    return null;
  }
}

// Save tracked item
async function saveTrackedItem(userId, channelId, url, targetPrice) {
  try {
    const trackedItems = await loadData(TRACKED_ITEMS_FILE);
    const key = `${userId}-${url}`;
    
    trackedItems[key] = {
      userId,
      channelId,
      url,
      targetPrice,
      createdAt: new Date().toISOString()
    };
    
    await saveData(TRACKED_ITEMS_FILE, trackedItems);
    return true;
  } catch (error) {
    console.error('Error saving tracked item:', error);
    return false;
  }
}

// Get all tracked items
async function getTrackedItems() {
  try {
    const trackedItems = await loadData(TRACKED_ITEMS_FILE);
    return Object.values(trackedItems);
  } catch (error) {
    console.error('Error getting tracked items:', error);
    return [];
  }
}

// Remove tracked item
async function removeTrackedItem(userId, url) {
  try {
    const trackedItems = await loadData(TRACKED_ITEMS_FILE);
    const key = `${userId}-${url}`;
    delete trackedItems[key];
    await saveData(TRACKED_ITEMS_FILE, trackedItems);
  } catch (error) {
    console.error('Error removing tracked item:', error);
  }
}

// Find current deals (recent price drops)
async function findCurrentDeals(limit = 5) {
  try {
    const priceHistory = await loadData(PRICE_HISTORY_FILE);
    const deals = [];
    
    for (const url in priceHistory) {
      const history = priceHistory[url];
      if (history.length < 2) continue;
      
      // Sort by timestamp
      history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      
      const latest = history[history.length - 1];
      const previous = history[history.length - 2];
      
      if (latest.price < previous.price) {
        const discountPercent = ((previous.price - latest.price) / previous.price * 100);
        
        if (discountPercent >= 5) { // At least 5% discount
          deals.push({
            url,
            title: latest.title,
            current_price: latest.price,
            previous_price: previous.price,
            discount_percent: discountPercent.toFixed(1),
            currency: latest.currency
          });
        }
      }
    }
    
    // Sort by discount percentage
    deals.sort((a, b) => parseFloat(b.discount_percent) - parseFloat(a.discount_percent));
    
    return deals.slice(0, limit);
  } catch (error) {
    console.error('Error finding deals:', error);
    return [];
  }
}

// ==================== SCRAPING FUNCTIONS ====================

// Helper function to scrape Empik product (now saves to storage)
async function scrapeEmpikProduct(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    
    // Empik price selectors (may need adjustment)
    const title = $('.product-title').text().trim() || $('.product-name').text().trim();
    const priceText = $('.price-current').text().trim() || $('.price').text().trim();
    const price = parseFloat(priceText.replace(/[^\d,]/g, '').replace(',', '.'));
    
    const product = {
      title: title || 'Unknown Product',
      price: price || 0,
      currency: 'PLN',
      url: url,
      timestamp: new Date()
    };
    
    // Save to price history
    if (product.price > 0) {
      await savePriceHistory(url, product.title, product.price, product.currency);
    }
    
    return product;
  } catch (error) {
    console.error('Scraping error:', error.message);
    return null;
  }
}

// Helper function to search Empik
async function searchEmpik(query) {
  try {
    const searchUrl = `https://www.empik.com/szukaj/produkt?q=${encodeURIComponent(query)}`;
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    
    const results = [];
    const seenUrls = new Set();
    
    $('.search-result-item, .product-item, .product-card, .search-item, [class*="product"]').each((i, elem) => {
      if (results.length >= 5) return;
      
      const $elem = $(elem);
      let title = $elem.find('.product-title, .product-name, [class*="title"], h2, h3').text().trim();
      let price = $elem.find('.price-current, .price, [class*="price"]').text().trim();
      const link = $elem.find('a').attr('href') || $elem.closest('a').attr('href');
      
      if (!link || seenUrls.has(link)) {
        return;
      }
      
      // Clean up title (remove duplicates)
      if (title) {
        const words = title.split(' ');
        const halfLength = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, halfLength).join(' ');
        const secondHalf = words.slice(halfLength).join(' ');
        
        if (firstHalf === secondHalf && firstHalf.length > 0) {
          title = firstHalf;
        }
        title = title.replace(/(.+)\s+\1/g, '$1');
      }
      
      // Clean up price
      if (price) {
        price = price
          .replace(/Megacena/gi, '')
          .replace(/Promocja/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        
        const priceMatch = price.match(/[\d,]+\s*zł/);
        if (priceMatch) {
          price = priceMatch[0];
        }
      }
      
      if (title && link) {
        const fullUrl = link.startsWith('http') ? link : `https://www.empik.com${link}`;
        seenUrls.add(link);
        
        results.push({
          title,
          price: price || 'Price not found',
          url: fullUrl
        });
      }
    });
    
    return results;
  } catch (error) {
    console.error('Search error:', error.message);
    return [];
  }
}

// ==================== BOT COMMANDS ====================

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const args = message.content.slice(1).split(' ');
  const command = args[0].toLowerCase();
  
  if (command === 'empik') {
    if (args.length < 2) {
      message.reply('Usage: `!empik <search term>` or `!empik <product URL>`');
      return;
    }
    
    const query = args.slice(1).join(' ');
    
    // Check if it's a URL
    if (query.includes('empik.com')) {
      const product = await scrapeEmpikProduct(query);
      if (product) {
        const stats = await getPriceStats(query);
        
        const embed = new Discord.EmbedBuilder()
          .setTitle(product.title)
          .setColor('#e74c3c')
          .addFields(
            { name: 'Current Price', value: `${product.price} ${product.currency}`, inline: true }
          );
        
        if (stats) {
          embed.addFields(
            { name: '30-Day Low', value: `${stats.lowest_price} PLN`, inline: true },
            { name: '30-Day High', value: `${stats.highest_price} PLN`, inline: true },
            { name: 'Average Price', value: `${stats.avg_price} PLN`, inline: true },
            { name: 'Price Checks', value: `${stats.price_checks}`, inline: true }
          );
        }
        
        embed.addFields({ name: 'Link', value: `[View on Empik](${product.url})`, inline: false })
             .setTimestamp();
        
        message.reply({ embeds: [embed] });
      } else {
        message.reply('Could not fetch product information.');
      }
    } else {
      // Search Empik
      message.reply('Searching Empik...');
      const results = await searchEmpik(query);
      
      if (results.length > 0) {
        const embed = new Discord.EmbedBuilder()
          .setTitle(`Empik Search Results for "${query}"`)
          .setColor('#3498db');
        
        results.forEach((result, i) => {
          embed.addFields({
            name: `${i + 1}. ${result.title}`,
            value: `💰 **${result.price}**\n🔗 [View on Empik](${result.url})`,
            inline: true
          });
        });
        
        message.reply({ embeds: [embed] });
      } else {
        message.reply('No results found on Empik.');
      }
    }
  }
  
  if (command === 'track') {
    if (args.length < 3) {
      message.reply('Usage: `!track <empik URL> <target price>`');
      return;
    }
    
    const url = args[1];
    const targetPrice = parseFloat(args[2]);
    
    if (!url.includes('empik.com') || isNaN(targetPrice)) {
      message.reply('Please provide a valid Empik URL and target price.');
      return;
    }
    
    const userId = message.author.id;
    const success = await saveTrackedItem(userId, message.channel.id, url, targetPrice);
    
    if (success) {
      message.reply(`✅ Now tracking price for ${url}. You'll be notified when it drops below ${targetPrice} PLN.`);
    } else {
      message.reply('❌ Failed to save tracking. Please try again.');
    }
  }
  
  if (command === 'deals') {
    message.reply('🔍 Finding current deals...');
    const deals = await findCurrentDeals(5);
    
    if (deals.length > 0) {
      const embed = new Discord.EmbedBuilder()
        .setTitle('🔥 Current Deals on Empik')
        .setColor('#f39c12')
        .setDescription('Items with recent price drops:');
      
      deals.forEach((deal, i) => {
        embed.addFields({
          name: `${i + 1}. ${deal.title}`,
          value: `~~${deal.previous_price} ${deal.currency}~~ → **${deal.current_price} ${deal.currency}**\n📉 **${deal.discount_percent}% OFF**\n🔗 [View Deal](${deal.url})`,
          inline: false
        });
      });
      
      embed.setFooter({ text: 'Deals are based on recent price changes' });
      
      message.reply({ embeds: [embed] });
    } else {
      message.reply('No current deals found. Try again later or search for specific items with `!empik`');
    }
  }
  
  if (command === 'stats' || command === 'history') {
    if (args.length < 2) {
      message.reply('Usage: `!stats <empik URL>`');
      return;
    }
    
    const url = args[1];
    if (!url.includes('empik.com')) {
      message.reply('Please provide a valid Empik URL.');
      return;
    }
    
    const stats = await getPriceStats(url);
    if (stats) {
      const embed = new Discord.EmbedBuilder()
        .setTitle('📊 Price Statistics (30 days)')
        .setColor('#9b59b6')
        .addFields(
          { name: 'Current Price', value: `${stats.latest_price} PLN`, inline: true },
          { name: 'Lowest Price', value: `${stats.lowest_price} PLN`, inline: true },
          { name: 'Highest Price', value: `${stats.highest_price} PLN`, inline: true },
          { name: 'Average Price', value: `${stats.avg_price} PLN`, inline: true },
          { name: 'Price Checks', value: `${stats.price_checks}`, inline: true },
          { name: 'Last Updated', value: new Date(stats.latest_check).toLocaleDateString(), inline: true }
        )
        .setFooter({ text: 'Statistics are based on daily price checks' });
      
      message.reply({ embeds: [embed] });
    } else {
      message.reply('No price history found for this URL. Try checking the price first with `!empik <URL>`');
    }
  }
  
  if (command === 'mytracking' || command === 'tracking') {
    const trackedItems = await getTrackedItems();
    const userItems = trackedItems.filter(item => item.userId === message.author.id);
    
    if (userItems.length === 0) {
      message.reply('You are not tracking any items. Use `!track <url> <price>` to start tracking.');
      return;
    }
    
    const embed = new Discord.EmbedBuilder()
      .setTitle('📋 Your Tracked Items')
      .setColor('#3498db');
    
    userItems.forEach((item, i) => {
      embed.addFields({
        name: `${i + 1}. Target: ${item.targetPrice} PLN`,
        value: `🔗 [View Item](${item.url})\n📅 Since: ${new Date(item.createdAt).toLocaleDateString()}`,
        inline: true
      });
    });
    
    message.reply({ embeds: [embed] });
  }
});

// Price checking scheduler (every 2 hours)
cron.schedule('0 */2 * * *', async () => {
  console.log('Checking tracked prices...');
  
  const trackedItems = await getTrackedItems();
  
  for (const item of trackedItems) {
    try {
      const product = await scrapeEmpikProduct(item.url);
      
      if (product && product.price <= item.targetPrice && product.price > 0) {
        const channel = client.channels.cache.get(item.channelId);
        if (channel) {
          const embed = new Discord.EmbedBuilder()
            .setTitle('🚨 Price Alert!')
            .setDescription(`**${product.title}** has dropped to **${product.price} PLN**!`)
            .setColor('#2ecc71')
            .addFields(
              { name: 'Target Price', value: `${item.targetPrice} PLN`, inline: true },
              { name: 'Current Price', value: `${product.price} PLN`, inline: true },
              { name: 'Link', value: `[Buy Now](${product.url})`, inline: false }
            )
            .setTimestamp();
          
          channel.send({ content: `<@${item.userId}>`, embeds: [embed] });
          
          // Remove from tracking after alert
          await removeTrackedItem(item.userId, item.url);
        }
      }
      
      // Add small delay to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('Error checking price for', item.url, error.message);
    }
  }
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log('Empik Price Tracker Bot is ready!');
  ensureDataDir(); // Create data directory on startup
});

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', console.error);

// Start the bot
client.login(process.env.DISCORD_TOKEN);
