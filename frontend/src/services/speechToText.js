import { translateText } from "./translate";
import socket from "./socket";

export function startListening() {
  const recognition = new window.webkitSpeechRecognition();
  recognition.lang = "hi-IN";

  recognition.onresult = async (event) => {
    const text = event.results[0][0].transcript;

    const translated = await translateText(text, "en");

    socket.emit("send-translation", {
      room: "room1",
      text: translated,
      lang: "en-US"
    });
  };

  recognition.start();
}