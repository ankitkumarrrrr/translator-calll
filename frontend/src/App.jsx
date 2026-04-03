import React from "react";
import VideoCall from "./components/VideoCall";

export default function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "linear-gradient(135deg, #0f172a 0%, #111827 45%, #1e293b 100%)",
        color: "white",
        padding: "20px",
        fontFamily: "Arial, sans-serif"
      }}
    >
      <div
        style={{
          maxWidth: "1600px",
          margin: "0 auto"
        }}
      >
        <h1
          style={{
            textAlign: "center",
            marginBottom: "20px",
            fontSize: "34px",
            fontWeight: "700",
            letterSpacing: "0.5px"
          }}
        >
          AI Translator Video Call
        </h1>

        <VideoCall />
      </div>
    </div>
  );
}