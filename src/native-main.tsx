import React from 'react';
import ReactDOM from 'react-dom/client';
import Prototype from './Prototype';
import { NativeSurface } from './native-mobile';
import './prototype.css';
import './native.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><NativeSurface><Prototype/></NativeSurface></React.StrictMode>);
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/app/sw.js',{scope:'/app/'}).catch(()=>{});
