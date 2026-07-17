import * as dotenv from 'dotenv';

dotenv.config();

async function testKey() {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  
  try {
    const res = await fetch(url);
    const data = await res.json() as any;
    console.log('Supported Models:');
    data.models.forEach((m: any) => {
      console.log(`- ${m.name}`);
    });
  } catch (err: any) {
    console.error('Fetch Error:', err.message);
  }
}

testKey();
