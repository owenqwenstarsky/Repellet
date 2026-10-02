const counter = document.querySelector('#counter');
let clicks = 0;

counter.addEventListener('click', () => {
  clicks += 1;
  counter.textContent = `Clicked ${clicks} ${clicks === 1 ? 'time' : 'times'}`;
});
