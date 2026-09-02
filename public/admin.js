const form = document.querySelector('#config-form');
const message = document.querySelector('#form-message');

const fields = {
  targetName: document.querySelector('#target-name'),
  garminUrl: document.querySelector('#garmin-url'),
  routeFormat: document.querySelector('#route-format'),
  routeText: document.querySelector('#route-text'),
};

loadConfig();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = 'Salvando...';
  const payload = {
    targetName: fields.targetName.value,
    garminUrl: fields.garminUrl.value,
    routeFormat: fields.routeFormat.value,
    routeText: fields.routeText.value,
  };

  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Erro ao salvar.');
    message.textContent = result.status?.error
      ? `Salvo, mas o rastreador ainda não retornou uma posição válida.`
      : 'Salvo. A primeira atualização foi solicitada.';
  } catch (error) {
    message.textContent = error.message;
  }
});

async function loadConfig() {
  const config = await fetch('/api/config').then((response) => response.json());
  fields.targetName.value = config.targetName || 'Caminhos de Rosa';
  fields.garminUrl.value = '';
  fields.garminUrl.placeholder = config.hasGarminUrl ? 'Link salvo anteriormente' : fields.garminUrl.placeholder;
  fields.routeFormat.value = config.routeFormat || '';
  fields.routeText.value = config.routeText || '';
}
