const Discord = require('discord.js');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
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
    const searchUrl = `https://www.empik.com/szukaj?q=${encodeURIComponent(query)}`;
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const results = [];
    
    // Extract search results (selectors may need adjustment)
    $('.search-result-item, .product-item').each((i, elem) => {
      if (i >= 5) return; // Limit to 5 results
      
      const title = $(elem).find('.product-title, .product-name').text().trim();
      const price = $(elem).find('.price-current, .price').text().trim();
      const link = $(elem).find('a').attr('href');
      
      if (title && price && link) {
        results.push({
          title,
          price: price.replace(/[^\d,]/g, '').replace(',', '.') + ' PLN',
          url: link.startsWith('http') ? link : `https://www.empik.com${link}`
        });
      }
    });
    
    return results;
  } catch (error) {
    console.error('Search error:', error.message);
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
            value: `Price: ${result.price}\n[View Product](${result.url})`,
            inline: false
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
