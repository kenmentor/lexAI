import dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]); // Google + Cloudflare DNS

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import fs from "fs";
import axios from "axios";
import { spawn } from "child_process";
import path from "path";

import qrcode from "qrcode-terminal";
import pino from "pino";
import FormData from "form-data";
import { PassThrough } from "stream";
import ffmpeg from "fluent-ffmpeg";

import WebSocket from "ws";
import { buffer } from "stream/consumers";

import dotenv from "dotenv";
dotenv.config();
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY;
const ULTRAVOX_VOICE_ID = process.env.VOICE_ID || "Allie";
const ULTRAVOX_BASE_URL = "https://api.ultravox.ai/api";

const ULTRAVOX_AGENT_CONFIG = {
  systemPrompt: "",
  model: "fixie-ai/ultravox",
  voice: ULTRAVOX_VOICE_ID,
  temperature: 0.3,
  firstSpeakerSettings: { user: {} },
  medium: {
    serverWebSocket: {
      inputSampleRate: 48000,
      outputSampleRate: 48000,
    },
  },
};
// ------------------ Logger Setup ------------------
const logger = pino({ level: "info" });

// ------------------ Ultravox Configuration ------------------

// ------------------ Start WhatsApp Bot ------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state });
  sock.ev.on("creds.update", saveCreds);

  // ------------------ Connection Handling ------------------
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log("Logged out. Delete auth_info folder and scan QR again.");
      } else {
        console.log("Connection closed. Reconnecting...");
        startBot();
      }
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }
  });

  // ------------------ Message Handling ------------------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    // if (msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    console.log("📩 New message from", sender);

    try {
      // ------------------ Voice Messages ------------------
      if (msg.message.audioMessage) {
        console.log("🎙️ Voice message received, downloading...");

        const stream = await downloadContentFromMessage(
          msg.message.audioMessage,
          "audio"
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream)
          buffer = Buffer.concat([buffer, chunk]);

        const filePath = `tempAudio_${Date.now()}.ogg`;
        fs.writeFileSync(filePath, buffer);
        console.log("✅ Audio saved locally");

        const voiceResponse = await generateResponseFromVoice(filePath);
        fs.unlinkSync(filePath);

        if (voiceResponse) {
          await sock.sendMessage(sender, {
            audio: voiceResponse,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true, // ✅ makes it look like a voice note
          });
          console.log("✅ AI voice response sent!");
        } else {
          await sock.sendMessage(sender, {
            text: "❌ Could not generate response.",
          });
        }
      }

      // ------------------ Text Messages ------------------
      if (msg.message.conversation) {
        const text = msg.message.conversation;
        console.log("💬 Text message:", text);
        await sock.sendMessage(sender, { text: "Got your message!" });
      }
    } catch (err) {
      console.error("❌ Error handling message:", err.message || err);
      await sock.sendMessage(sender, { text: "⚠️ Something went wrong!" });
    }
  });
}

///// how to use the ultravox service///
//--------------------create a call-------------------
//this will include all need data to talk with your ai model

//-------- webSocket transfer ----------------------------
//use websocket to transfer data (seend raw PCM audio bytes directly to the websocket )//
//------------ handle audio format -------------------------------
//conver to a specifc format and send

//:::::::::::::::::::::::::::::
//--------------------Create Agent------------------------

async function createAgent() {
  try {
    const response = await fetch(`${ULTRAVOX_BASE_URL}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": ULTRAVOX_API_KEY,
      },
      body: JSON.stringify(ULTRAVOX_AGENT_CONFIG), // ✅ must stringify
    });

    const data = await response.json(); // ✅ parse the actual response
    if (!response.ok) {
      console.error("❌ Error creating agent:", data);
      return null;
    }

    console.log("✅ Agent created:", data);
    return data;
  } catch (err) {
    console.error("🚨 Request failed:", err);
  }
}

//------------------Create Call-----------------------------
async function createCallSocket() {
  try {
    const response = await axios.post(
      `${ULTRAVOX_BASE_URL}/calls`,
      {
        systemPrompt:
          "You are a helpful assistant. Be polite and professional.",
        voice: "Jessica",
        model: "fixie-ai/ultravox",
        temperature: 0.3,
        maxDuration: "3600s",
        joinTimeout: "30s",
        recordingEnabled: false,
        medium: {
          serverWebSocket: {
            inputSampleRate: 48000,
            outputSampleRate: 48000,
          },
        },
        initialMessages: [
          {
            role: "MESSAGE_ROLE_AGENT",
            text: "Hello! Let's begin.",
          },
        ],
        metadata: {
          test: "direct_call",
        },
      },

      {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": ULTRAVOX_API_KEY,
        },
      }
    );

    const data = response.data;
    console.log("Call created:", data);
    return data;
  } catch (err) {
    console.error(
      "Error creating direct call:",
      err.response?.data || err.message
    );
    throw err;
  }
}

//---------------joincall--------------------------------
async function connectWebSocket(filePath) {
  const call = await createCallSocket();
  const ws = new WebSocket(call.joinUrl, {
    headers: { Host: "voice.ultravox.ai" },
  });

  let audioBuffer = Buffer.from([]);

  ws.on("open", () => {
    console.log("✅ Connected to Ultravox");
    startAudioStreaming(ws, filePath);
  });

  ws.on("message", (data) => {
    if (data instanceof Buffer) {
      console.log(`🎵 Received audio chunk (${data.length} bytes)`);
      audioBuffer = Buffer.concat([audioBuffer, data]);
    } else {
      const message = JSON.parse(data.toString());
      handleDataMessage(message, ws);
    }
  });
  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
    setTimeout(connectWebSocket, 5000); // retry after 5s
  });
  return new Promise((resolve) => {
    ws.on("close", () => {
      console.log("🔌 Ultravox connection closed");
      if (audioBuffer.length > 0) {
        const outFile = `ultravox_response_${Date.now()}.ogg`;
        fs.writeFileSync(outFile, audioBuffer);
        console.log("💾 Saved Ultravox response to", outFile);
        resolve(fs.readFileSync(outFile));
      } else {
        resolve(null);
      }
    });
  });
}
//::::::::::::::::::::::::::::::: send audio chuncks to agent :::::::::::::::::;;;;

function startAudioStreaming(ws, filePath) {
  console.log("🎧 Starting audio stream…");

  ffmpeg(filePath)
    .inputFormat("ogg")
    .audioCodec("pcm_s16le")
    .format("s16le")
    .audioChannels(1)
    .audioFrequency(48000)

    .on("error", (err) => console.error("❌ ffmpeg error:", err.message))
    .on("end", () => {
      console.log("✅ Finished streaming to Ultravox");
      ws.send(JSON.stringify({ type: "input_audio_done" })); // let server know
    })
    .pipe()
    .on("data", (chunk) => {
      ws.send(chunk);
    });
}

//:::::::::::::::: play recieved agent audio::::::::::::::::::::::::::::::

function playAudio(audioData) {
  const audioContext = new AudioContext();
  audioContext.decodeAudioData(audioData).then((buffer) => {
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();
  });
}
//::::::::::::::::: handle data message (transcripts, status,etc) :::::::::::::::::::::::

function handleDataMessage(message, ws) {
  if (message.type === "session_created") {
    console.log("🔗 Session established:", message.session_id);
  } else if (message.type === "call_completed") {
    console.log("📞 Call completed");
    ws.close();
  } else {
    console.log("ℹ️ Data message:", message);
  }
}

//:::::::::::::::::::::::: convert Float32Array to PCM s16le :::::::::::

function convertToPCM(Float32Array) {
  const buffer = new ArrayBuffer(Float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < Float32Array.length; i++) {
    const sample = Math.max(-1, Math.min(1, Float32Array[i]));
    view.setInt16(i * 2, sample * 0x7ff, true);
  }
  return buffer;
}

// ::::::::::::::::::::::Generate AI Voice from userVOICE input:::::::::::::::::::::::::::

async function generateResponseFromVoice(filePath) {
  try {
    const pcmBuffer = await connectWebSocket(filePath); // fixed function name

    if (!pcmBuffer || pcmBuffer.length === 0) {
      throw new Error("No voice returned from Ultravox");
    }

    // Save raw PCM first (for debugging)
    const rawPath = path.resolve(`ultravox_raw_${Date.now()}.pcm`);
    fs.writeFileSync(rawPath, pcmBuffer);

    // Convert PCM → OGG (Opus) with ffmpeg
    const oggPath = path.resolve(`voiceResponse_${Date.now()}.ogg`);

    await new Promise((resolve, reject) => {
      const ffmpegProc = spawn("ffmpeg", [
        "-f",
        "s16le", // PCM format
        "-ar",
        "48000", // sample rate
        "-ac",
        "1", // mono
        "-i",
        "pipe:0", // read from stdin
        "-c:a",
        "libopus", // encode to Opus
        oggPath, // output file
      ]);

      ffmpegProc.stdin.write(pcmBuffer);
      ffmpegProc.stdin.end();

      ffmpegProc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed with code ${code}`));
      });
    });

    return fs.readFileSync(oggPath);
  } catch (err) {
    console.error("🚨 AI voice-from-voice error:", err.message);
    return null;
  }
}

// ------------------ Run Bot ------------------
startBot();
