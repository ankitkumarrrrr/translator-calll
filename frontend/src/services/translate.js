export async function translateText(text, target) {
  const res = await fetch(
    `http://localhost:5000/translate?text=${text}&target=${target}`
  );
  const data = await res.json();
  return data.translated;
}