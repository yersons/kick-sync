// # Página de inicio: muestra errores de login y cambia el botón si ya hay sesión
const ERRORS = {
  registros_cerrados: 'Los registros están cerrados por ahora.',
  sesion_expirada: 'La sesión de login expiró, intenta de nuevo.',
  token_fallido: 'Kick rechazó el login. Revisa el Client Secret y el Redirect URI.',
  usuario_fallido: 'No pude leer tu usuario de Kick.',
  access_denied: 'Cancelaste el acceso.',
};

const error = new URLSearchParams(location.search).get('error');
if (error) $('#err').textContent = ERRORS[error] || `Error: ${error}`;

api('GET', '/api/me')
  .then(({ user }) => {
    if (!user) return;
    $('#login').textContent = `Ir al panel (${user.name})`;
    $('#login').href = '/dashboard';
  })
  .catch(() => {});
