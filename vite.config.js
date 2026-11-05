// Só para servir no Quest por HTTPS (certificado autoassinado). A app não precisa de build.
import basicSsl from '@vitejs/plugin-basic-ssl';
export default { plugins: [basicSsl()], server: { host: true } };
