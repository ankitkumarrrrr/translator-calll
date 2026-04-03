export default function LanguageSelector({ setLang }) {
  return (
    <select onChange={(e) => setLang(e.target.value)}>
      <option value="en">English</option>
      <option value="hi">Hindi</option>
    </select>
  );
}