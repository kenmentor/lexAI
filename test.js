import axios from "axios";

import WebSocket from "ws";
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

async function connctWebSocket(filePath) {
  const call = await createCallSocket();
  const ws = new WebSocket(call.joinUrl, {
    headers: {
      Host: "voice.ultravox.ai", // keep host header correct
    },
  });
  ws.onopen = () => {
    console.log("connected to Ultravox");
    startAudioStreaming(ws, filePath);
  };
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      //::::::::::::::::::::: recieve agent voice audio (binary)::::::::::::::::

      playAudio(event.data);
    } else {
      //:::::::::::: recieved data message (JSON) ::::::::::::::::::
      const message = JSON.parse(event.data);
      handleDataMessage(message);
    }
  };
}

connctWebSocket();
//::::::::::::::::::::::::::::::: send audio chuncks to agent :::::::::::::::::;;;;

function startAudioStreaming(ws, filePath) {
  const ffmpegStream = new PassThrough();

  // Use ffmpeg to decode WhatsApp OGG/Opus into PCM s16le, 48kHz mono
  ffmpeg(filePath)
    .format("s16le")
    .audioChannels(1)
    .audioFrequency(48000)
    .on("error", (err) => {
      console.error("FFmpeg error:", err.message);
    })
    .pipe(ffmpegStream);

  ffmpegStream.on("data", (chunk) => {
    // Each chunk is raw PCM16 — Ultravox accepts binary frames
    ws.send(chunk);
  });

  ffmpegStream.on("end", () => {
    console.log("✅ Finished streaming audio file to Ultravox");
    ws.close();
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

function handleDataMessage(message) {
  switch (message.type) {
    case "transcript":
      console.log(`${message.role}:${message.text}`);
      break;
    case "state":
      console.log("state:", message.state);
      break;
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

// async function createAgent() {
//   try {
//     const response = await fetch(`${ULTRAVOX_BASE_URL}/agents`, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "X-API-Key": ULTRAVOX_API_KEY,
//       },
//       body: JSON.stringify(ULTRAVOX_AGENT_CONFIG), // ✅ must stringify
//     });

//     const data = await response.json(); // ✅ parse the actual response
//     if (!response.ok) {
//       console.error("❌ Error creating agent:", data);
//       return null;
//     }

//     console.log("✅ Agent created:", data);
//     return data;
//   } catch (err) {
//     console.error("🚨 Request failed:", err);
//   }
// }

// async function main() {
//   const agent = await createAgent();
//   if (agent && agent.agentId) {
//     console.log(agent.agentId, "this is the agent i called");
//   }
// }

// main();
// async function createCallSocket() {
//   const agent = await createAgent();

//   if (agent && agent.agentId) {
//     const URL = `https://api.ultravox.ai/api/agents/${agent.agentId}/calls`;

//     const ultravoxCall = await axios.post(
//       URL,
//       {
//         templateContext: {
//           customerName: "jame", // make sure this matches the placeholder in your call template
//         },
//       },
//       {
//         headers: {
//           "Content-Type": "application/json",
//           "X-API-Key": ULTRAVOX_API_KEY,
//         },
//       }
//     );

//     // axios automatically parses JSON into .data, no need for await here
//     const { joinUrl } = ultravoxCall.data;

//     console.log("✅ Call created, join at:", joinUrl);
//     return joinUrl;
//   }
// }
