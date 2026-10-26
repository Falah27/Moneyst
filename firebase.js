import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig, SPACE_ID } from './config.js';

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// semua data berada di spaces/{SPACE_ID}/{nama}
export const col = name => collection(db, 'spaces', SPACE_ID, name);

export { doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch };