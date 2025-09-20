// server.js
import express from "express";
import twilio from "twilio";
import https from "https";
import dotenv from "dotenv";
dotenv.config();
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ------------------------------------------------------------
// Step 1:  Configure Twilio account and destination number
// ------------------------------------------------------------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const DESTINATION_PHONE_NUMBER = process.env.DESTINATION_PHONE_NUMBER;
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;

// ------------------------------------------------------------
// Step 2:  Configure Ultravox API key
// ------------------------------------------------------------

const SYSTEM_PROMPT =
  "Your Name is FAITH and you are calling a person on the phone. Ask them their name and see how they are doing.";

const ULTRAVOX_CALL_CONFIG = {
  systemPrompt: SYSTEM_PROMPT,
  model: "fixie-ai/ultravox",
  voice: process.env.VOICE_ID,
  temperature: 0.3,
  firstSpeakerSettings: { user: {} },
  medium: { twilio: {} },
};

// ------------------------------------------------------------
// Validation
function validateConfiguration() {
  const requiredConfig = [
    {
      name: "TWILIO_ACCOUNT_SID",
      value: TWILIO_ACCOUNT_SID,
      pattern: /^AC[a-zA-Z0-9]{32}$/,
    },
    {
      name: "TWILIO_AUTH_TOKEN",
      value: TWILIO_AUTH_TOKEN,
      pattern: /^[a-zA-Z0-9]{32}$/,
    },
    {
      name: "TWILIO_PHONE_NUMBER",
      value: TWILIO_PHONE_NUMBER,
      pattern: /^\+[1-9]\d{1,14}$/,
    },
    {
      name: "DESTINATION_PHONE_NUMBER",
      value: DESTINATION_PHONE_NUMBER,
      pattern: /^\+[1-9]\d{1,14}$/,
    },
    {
      name: "ULTRAVOX_API_KEY",
      value: ULTRAVOX_API_KEY,
      pattern: /^[a-zA-Z0-9]{8}\.[a-zA-Z0-9]{32}$/,
    },
  ];

  const errors = [];

  for (const config of requiredConfig) {
    if (
      !config.value ||
      config.value.includes("your_") ||
      config.value.includes("_here")
    ) {
      errors.push(
        `❌ ${config.name} is not set or still contains placeholder text`
      );
    } else if (config.pattern && !config.pattern.test(config.value)) {
      errors.push(`❌ ${config.name} format appears invalid`);
    }
  }

  if (errors.length > 0) {
    console.error("🚨 Configuration Error(s):");
    errors.forEach((error) => console.error(`   ${error}`));
    process.exit(1);
  }

  console.log("✅ Configuration validation passed!");
}

// ------------------------------------------------------------
// Ultravox call
async function createUltravoxCall() {
  const ULTRAVOX_API_URL = "https://api.ultravox.ai/api/calls";
  const request = https.request(ULTRAVOX_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": ULTRAVOX_API_KEY,
    },
  });

  return new Promise((resolve, reject) => {
    let data = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => {
        try {
          const parsedData = JSON.parse(data);
          if (response.statusCode >= 200 && response.statusCode < 300)
            resolve(parsedData);
          else
            reject(
              new Error(`Ultravox API error (${response.statusCode}): ${data}`)
            );
        } catch {
          reject(new Error(`Failed to parse Ultravox response: ${data}`));
        }
      });
    });
    request.on("error", (error) =>
      reject(new Error(`Network error calling Ultravox: ${error.message}`))
    );
    request.write(JSON.stringify(ULTRAVOX_CALL_CONFIG));
    request.end();
  });
}

// ------------------------------------------------------------
// Endpoint to trigger an outbound call
app.get("/call", async (req, res) => {
  console.log("🚀 Triggering outbound Ultravox call...");
  validateConfiguration();

  try {
    const ultravoxResponse = await createUltravoxCall();
    if (!ultravoxResponse.joinUrl)
      throw new Error("No joinUrl received from Ultravox API");

    console.log("✅ Got Ultravox joinUrl:", ultravoxResponse.joinUrl);

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const call = await client.calls.create({
      twiml: `<Response><Connect><Stream url="${ultravoxResponse.joinUrl}"/></Connect></Response>`,
      to: DESTINATION_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
    });

    console.log("🎉 Twilio outbound phone call initiated successfully!");
    res.json({
      success: true,
      callSid: call.sid,
      joinUrl: ultravoxResponse.joinUrl,
    });
  } catch (error) {
    console.error("💥 Error occurred:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ------------------------------------------------------------
// Endpoint to receive incoming calls (optional)
app.post("/incoming-call", (req, res) => {
  console.log("hello");
  console.log("📞 Incoming call received from:", req.body.From);

  const ULTRAVOX_JOIN_URL = "https://api.ultravox.ai/join/your-call-id"; // Replace dynamically if needed
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.connect().stream({ url: ULTRAVOX_JOIN_URL });

  res.type("text/xml").send(twiml.toString());
});

// ------------------------------------------------------------
// Start Express server
const PORT = 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
