require('dotenv').config();
const axios = require('axios');

const texts = [
  'ARTÍCULO 1°.- Establécese en el ámbito de la Provincia de Buenos Aires el régimen de ordenamiento territorial y uso del suelo.',
  'Ley que regula la organización y funcionamiento de las municipalidades bonaerenses.',
  'ARTÍCULO 15°.- Los intendentes municipales durarán cuatro años en sus funciones y podrán ser reelectos.',
];

function cosine(a, b) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (na * nb);
}

async function main() {
  const res = await axios.post(
    `${process.env.ZHIPU_BASE_URL}/embeddings`,
    { model: 'embedding-3', input: texts },
    { headers: { Authorization: `Bearer ${process.env.ZHIPU_API_KEY}` } }
  );

  const { model, usage, data } = res.data;
  console.log('Model :', model);
  console.log('Tokens:', JSON.stringify(usage));
  console.log('Vecs  :', data.length, '\n');

  data.forEach((item, i) => {
    const vec = item.embedding;
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    console.log(`[${i}] dims=${vec.length}  norm=${norm.toFixed(6)}`);
    console.log(`     texto: ${texts[i].slice(0, 70)}`);
    console.log(`     primeros 5: [${vec.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);
  });

  const vecs = data.map(d => d.embedding);
  console.log('\nSimilitudes coseno:');
  console.log(`  [0] vs [1]: ${cosine(vecs[0], vecs[1]).toFixed(4)}  art.territorial vs resumen ley municipalidades`);
  console.log(`  [0] vs [2]: ${cosine(vecs[0], vecs[2]).toFixed(4)}  art.territorial vs art.intendentes`);
  console.log(`  [1] vs [2]: ${cosine(vecs[1], vecs[2]).toFixed(4)}  resumen ley vs art.intendentes`);
}

main().catch(e => {
  console.error('ERROR:', e.response?.data || e.message);
  process.exit(1);
});
