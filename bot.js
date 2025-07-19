const Discord = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
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

// In-memory storage (use a database in production)
const trackedItems = new Map();
const priceHistory = new Map();

// Helper function to scrape Empik product
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
    
    return {
      title: title || 'Unknown Product',
      price: price || 0,
      currency: 'PLN',
      url: url,
      timestamp: new Date()
    };
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
    
    // Debug: Log what we actually got
    console.log('Response status:', response.status);
    console.log('Page title:', $('title').text());
    console.log('Page contains "minecraft":', response.data.toLowerCase().includes('minecraft'));
    console.log('Found elements with "product":', $('[class*="product"]').length);
    
    const results = [];
    
    // Try multiple possible selectors
    const possibleSelectors = [
      '.search-result-item',
      '.product-item', 
      '.product-card',
      '.search-item',
      '[data-testid*="product"]',
      '.productCard',
      '.item-product'
    ];
    
    let foundElements = 0;
    possibleSelectors.forEach(selector => {
      const count = $(selector).length;
      if (count > 0) {
        console.log(`Found ${count} elements with selector: ${selector}`);
        foundElements += count;
      }
    });
    
    if (foundElements === 0) {
      console.log('No product elements found with common selectors');
      // Log first 1000 chars of HTML to see structure
      console.log('HTML preview:', response.data.substring(0, 1000));
    }
    
    // Extract search results (try common patterns)
    $('.search-result-item, .product-item, .product-card, .search-item, [class*="product"]').each((i, elem) => {
      if (i >= 5) return; // Limit to 5 results
      
      const $elem = $(elem);
      let title = $elem.find('.product-title, .product-name, [class*="title"], h2, h3').text().trim();
      let price = $elem.find('.price-current, .price, [class*="price"]').text().trim();
      const link = $elem.find('a').attr('href') || $elem.closest('a').attr('href');
      
      // Clean up title (remove duplicates)
      if (title) {
        const words = title.split(' ');
        const halfLength = Math.floor(words.length / 2);
        const firstHalf = words.slice(0, halfLength).join(' ');
        const secondHalf = words.slice(halfLength).join(' ');
        
        // If first half equals second half, it's duplicated
        if (firstHalf === secondHalf && firstHalf.length > 0) {
          title = firstHalf;
        }
      }
      
      // Clean up price (remove "Megacena", extra spaces, etc.)
      if (price) {
        price = price
          .replace(/Megacena/gi, '')
          .replace(/Promocja/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        
        // Extract just the price with currency
        const priceMatch = price.match(/[\d,]+\s*zł/);
        if (priceMatch) {
          price = priceMatch[0];
        }
      }
      
      console.log(`Item ${i}: title="${title}", price="${price}", link="${link}"`);
      
      if (title && link) {
        results.push({
          title,
          price: price || 'Price not found',
          url: link.startsWith('http') ? link : `https://www.empik.com${link}`
        });
      }
    });
    
    console.log(`Final results count: ${results.length}`);
    return results;
  } catch (error) {
    console.error('Search error details:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      url: error.config?.url
    });
    return [];
  }
}

// Bot commands
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
        const embed = new Discord.EmbedBuilder()
          .setTitle(product.title)
          .setColor('#e74c3c')
          .addFields(
            { name: 'Price', value: `${product.price} ${product.currency}`, inline: true },
            { name: 'Link', value: `[View on Empik](${product.url})`, inline: true }
          )
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
    const trackingKey = `${userId}-${url}`;
    
    trackedItems.set(trackingKey, {
      userId,
      url,
      targetPrice,
      channelId: message.channel.id
    });
    
    message.reply(`✅ Now tracking price for ${url}. You'll be notified when it drops below ${targetPrice} PLN.`);
  }
  
  if (command === 'deals') {
    message.reply('🔥 Empik deals feature coming soon! For now, use `!empik <search term>` to check prices.');
  }
});

// Price checking scheduler (every 30 minutes)
cron.schedule('*/30 * * * *', async () => {
  console.log('Checking tracked prices...');
  
  for (const [key, item] of trackedItems.entries()) {
    const product = await scrapeEmpikProduct(item.url);
    
    if (product && product.price <= item.targetPrice) {
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
        trackedItems.delete(key);
      }
    }
  }
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log('Empik Price Tracker Bot is ready!');
});

// Error handling
client.on('error', console.error);
process.on('unhandledRejection', console.error);

// Start the bot
client.login(process.env.DISCORD_TOKEN);
