const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Document Extractor API Setup...\n');

// Test 1: Check Node.js version
console.log('1. Checking Node.js version...');
const nodeVersion = process.version;
console.log(`   Node.js version: ${nodeVersion}`);
if (parseInt(nodeVersion.slice(1)) >= 16) {
  console.log('   ✅ Node.js version is compatible\n');
} else {
  console.log('   ❌ Node.js version should be 16 or higher\n');
}

// Test 2: Check if package.json exists
console.log('2. Checking package.json...');
if (fs.existsSync('package.json')) {
  console.log('   ✅ package.json found\n');
} else {
  console.log('   ❌ package.json not found\n');
}

// Test 3: Check dependencies
console.log('3. Checking dependencies...');
const requiredDeps = ['express', 'multer', 'cors', 'openai', 'pdf-parse', 'mammoth', 'dotenv'];
let allDepsInstalled = true;

requiredDeps.forEach(dep => {
  try {
    require.resolve(dep);
    console.log(`   ✅ ${dep}`);
  } catch (error) {
    console.log(`   ❌ ${dep} - Not installed`);
    allDepsInstalled = false;
  }
});

if (allDepsInstalled) {
  console.log('   ✅ All dependencies are installed\n');
} else {
  console.log('   ❌ Some dependencies are missing. Run: npm install\n');
}

// Test 4: Check uploads directory
console.log('4. Checking uploads directory...');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('   ✅ Created uploads directory\n');
  } catch (error) {
    console.log('   ❌ Could not create uploads directory\n');
  }
} else {
  console.log('   ✅ Uploads directory exists\n');
}

// Test 5: Check environment variables
console.log('5. Checking environment configuration...');
require('dotenv').config();

if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here') {
  console.log('   ✅ OpenAI API key is configured');
} else {
  console.log('   ⚠️  OpenAI API key not found or using placeholder');
  console.log('      Please update your .env file with a valid OpenAI API key');
}

console.log(`   📍 Server will run on port: ${process.env.PORT || 3000}\n`);

// Test 6: Test server startup (without actually starting)
console.log('6. Testing server configuration...');
try {
  const app = require('./server.js');
  console.log('   ✅ Server configuration is valid\n');
} catch (error) {
  console.log('   ❌ Server configuration error:', error.message, '\n');
}

console.log('🎉 Setup test completed!');
console.log('\nNext steps:');
console.log('1. Make sure your .env file has a valid OpenAI API key');
console.log('2. Run: npm start (or npm run dev for development)');
console.log('3. Test the API at http://localhost:3000/health');
