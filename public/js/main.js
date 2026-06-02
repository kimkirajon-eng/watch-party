(() => {
  const createForm = document.getElementById('createForm');
  const joinForm = document.getElementById('joinForm');
  const createBtn = document.getElementById('createBtn');
  const joinBtn = document.getElementById('joinBtn');
  const errorMsg = document.getElementById('errorMessage');
  const tabs = document.querySelectorAll('.tab');

  const showError = (msg) => {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
    setTimeout(() => errorMsg.classList.add('hidden'), 5000);
  };

  const setLoading = (btn, loading) => {
    const text = btn.querySelector('.btn-text');
    const spinner = btn.querySelector('.btn-loading');
    btn.disabled = loading;
    text.classList.toggle('hidden', loading);
    spinner.classList.toggle('hidden', !loading);
  };

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(tab.dataset.tab + 'Form').classList.remove('hidden');
      errorMsg.classList.add('hidden');
    });
  });

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('createUsername').value.trim();
    if (!username) return;

    setLoading(createBtn, true);
    errorMsg.classList.add('hidden');

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Oda oluşturulamadı');
      }

      const data = await res.json();
      const params = new URLSearchParams({
        roomId: data.roomId,
        username,
        isHost: 'true',
      });
      window.location.href = `/room.html?${params.toString()}`;
    } catch (err) {
      showError(err.message);
      setLoading(createBtn, false);
    }
  });

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('joinUsername').value.trim();
    const roomCode = document.getElementById('roomCode').value.trim().toLowerCase();
    if (!username || !roomCode) return;

    setLoading(joinBtn, true);
    errorMsg.classList.add('hidden');

    try {
      const res = await fetch(`/api/rooms/${roomCode}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Oda bulunamadı');
      }

      const params = new URLSearchParams({
        roomId: roomCode,
        username,
        isHost: 'false',
      });
      window.location.href = `/room.html?${params.toString()}`;
    } catch (err) {
      showError(err.message);
      setLoading(joinBtn, false);
    }
  });
})();
