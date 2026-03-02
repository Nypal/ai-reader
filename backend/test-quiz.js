fetch('http://localhost:3001/api/quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: "Reading is fundamental. It opens the mind." })
})
    .then(r => r.text())
    .then(console.log)
    .catch(console.error);
