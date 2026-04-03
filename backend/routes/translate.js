const express = require("express");
const router = express.Router();

router.get("/", async (req, res) => {
  const { text, target } = req.query;

  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${text}`
  );

  const data = await response.json();
  res.json({ translated: data[0][0][0] });
});

module.exports = router;