import './style.css';
import { createIcons, icons } from 'lucide';
import App from './editor/App';
import { loadDemoScene } from './DemoScene';

const app = new App();
loadDemoScene(app);

createIcons({ icons });