/**
 * Taskly - Premium To-Do & Task Management with Firebase Sync
 * Completely optimized to prevent infinite loading loops and speed up page load.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut, 
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
  getDatabase, 
  ref, 
  set, 
  push, 
  remove, 
  update, 
  onValue 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// ==========================================================================
// 2. FIREBASE INITIALIZATION & CONFIGURATION
// ==========================================================================
const firebaseConfig = {
  apiKey: "AIzaSyBRalkWVNgam28GiWpALjM4l6YTCKDv_vM",
  authDomain: "taskly-todo-a6824.firebaseapp.com",
  projectId: "taskly-todo-a6824",
  storageBucket: "taskly-todo-a6824.firebasestorage.app",
  messagingSenderId: "436948853120",
  appId: "1:436948853120:web:8595708122e33c8f222165",
  measurementId: "G-RM4668QT5B",
  databaseURL: "https://taskly-todo-a6824-default-rtdb.firebaseio.com"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('profile');
googleProvider.addScope('email');

// ==========================================================================
// 3. STATE MANAGEMENT & DATA MODELS (TaskStore)
// ==========================================================================
class TaskStore {
  constructor() {
    this.STORAGE_KEYS = {
      SELECTED_CAT: 'taskly_selected_category',
      SELECTED_STATUS: 'taskly_selected_status',
      THEME: 'taskly_theme'
    };

    this.selectedCategoryId = this.load(this.STORAGE_KEYS.SELECTED_CAT) || 'all';
    this.selectedStatusFilter = this.load(this.STORAGE_KEYS.SELECTED_STATUS) || 'all';
    this.theme = this.load(this.STORAGE_KEYS.THEME) || 'light';

    this.categories = [];
    this.tasks = [];
    this.userId = null;
    this.onUpdate = null;
    this.newTaskCategoryId = 'work';

    this.unsubscribeCategories = null;
    this.unsubscribeTasks = null;
  }

  save(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  load(key) {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  }

  setTheme(theme) {
    this.theme = theme;
    this.save(this.STORAGE_KEYS.THEME, theme);
  }

  bindUser(userId, callbacks) {
    this.userId = userId;
    this.unbindUser(); 
    this.userId = userId;

    const categoriesRef = ref(db, `users/${userId}/categories`);
    const tasksRef = ref(db, `users/${userId}/tasks`);

    // Listen to Categories
    this.unsubscribeCategories = onValue(categoriesRef, (snapshot) => {
      const data = snapshot.val();
      let cats = [];
      if (data) {
        Object.keys(data).forEach(key => {
          cats.push({ id: key, ...data[key] });
        });
      }

      const seedKey = `taskly_seeded_${userId}`;

      if (cats.length === 0 && !localStorage.getItem(seedKey)) {
        localStorage.setItem(seedKey, 'true'); 

        const defaults = {
          work: { name: 'Work', color: '#3B82F6', createdAt: Date.now() },
          personal: { name: 'Personal', color: '#8B5CF6', createdAt: Date.now() + 1 },
          shopping: { name: 'Shopping', color: '#EC4899', createdAt: Date.now() + 2 }
        };
        
        this.categories = Object.keys(defaults).map(key => ({ id: key, ...defaults[key] }));
        this.newTaskCategoryId = 'work';
        
        set(categoriesRef, defaults).catch(e => console.error("Database seed blocked:", e));
        
        if (this.onUpdate) this.onUpdate();
        if (callbacks && callbacks.onCategoriesSynced) {
          callbacks.onCategoriesSynced();
        }
        return; 
      }

      if (cats.length === 0) {
         localStorage.setItem(seedKey, 'true');
      }

      cats.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      this.categories = cats;
      
      const defaultCatId = this.categories.length > 0 ? this.categories[0].id : 'uncategorized';
      if (!this.categories.some(c => c.id === this.newTaskCategoryId)) {
        this.newTaskCategoryId = defaultCatId;
      }
      if (this.selectedCategoryId !== 'all' && !this.categories.some(c => c.id === this.selectedCategoryId)) {
        this.selectedCategoryId = 'all';
      }

      if (this.onUpdate) this.onUpdate();
      if (callbacks && callbacks.onCategoriesSynced) {
        callbacks.onCategoriesSynced();
      }
    }, (error) => {
      console.error("Database categories sync error:", error);
      if (callbacks && callbacks.onCategoriesSynced) callbacks.onCategoriesSynced();
    });

    // Listen to Tasks
    this.unsubscribeTasks = onValue(tasksRef, (snapshot) => {
      const data = snapshot.val();
      let tks = [];
      if (data) {
        Object.keys(data).forEach(key => {
          tks.push({ id: key, ...data[key] });
        });
      }

      tks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      this.tasks = tks;

      if (this.onUpdate) this.onUpdate();
      if (callbacks && callbacks.onTasksSynced) {
        callbacks.onTasksSynced();
      }
    }, (error) => {
      console.error("Database tasks sync error:", error);
      if (callbacks && callbacks.onTasksSynced) callbacks.onTasksSynced();
    });
  }

  unbindUser() {
    if (this.unsubscribeCategories) this.unsubscribeCategories();
    if (this.unsubscribeTasks) this.unsubscribeTasks();
    this.unsubscribeCategories = null;
    this.unsubscribeTasks = null;
    this.userId = null;
    this.tasks = [];
    this.categories = [];
  }

  async addTask(text, categoryId) {
    if (!text.trim() || !this.userId) return;
    const defaultCatId = this.categories.length > 0 ? this.categories[0].id : 'uncategorized';
    const tasksRef = ref(db, `users/${this.userId}/tasks`);
    const newTaskRef = push(tasksRef);

    const newTask = {
      text: text.trim(),
      completed: false,
      categoryId: (categoryId && categoryId !== 'uncategorized') ? categoryId : defaultCatId,
      createdAt: Date.now()
    };

    try {
      await set(newTaskRef, newTask);
    } catch (e) {
      console.error("Error saving task:", e);
    }
  }

  async deleteTask(id) {
    if (!this.userId) return;
    try {
      await remove(ref(db, `users/${this.userId}/tasks/${id}`));
    } catch (e) {
      console.error("Error deleting task:", e);
    }
  }

  async toggleTask(id) {
    if (!this.userId) return;
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      const completed = !task.completed;
      const updates = { completed: completed };
      updates.completedAt = completed ? new Date().toISOString() : null;

      try {
        await update(ref(db, `users/${this.userId}/tasks/${id}`), updates);
      } catch (e) {
        console.error("Error updating task status:", e);
      }
    }
  }

  async addCategory(name, color) {
    if (!name.trim() || !this.userId) return;
    const categoriesRef = ref(db, `users/${this.userId}/categories`);
    const newCatRef = push(categoriesRef);

    const newCat = {
      name: name.trim(),
      color: color || '#F0521D',
      createdAt: Date.now()
    };

    try {
      await set(newCatRef, newCat);
    } catch (e) {
      console.error("Error creating category:", e);
    }
  }

  getCategoryById(id) {
    return this.categories.find(c => c.id === id);
  }

  async updateCategory(id, name, color) {
    if (!this.userId) return;
    const updates = { name: name.trim() };
    if (color) updates.color = color;

    try {
      await update(ref(db, `users/${this.userId}/categories/${id}`), updates);
    } catch (e) {
      console.error("Error updating category:", e);
    }
  }

  async deleteCategory(id) {
    if (id === 'all' || !this.userId) return;
    const activeCategories = this.categories.filter(c => c.id !== id);
    const defaultCatId = activeCategories.length > 0 ? activeCategories[0].id : 'uncategorized';

    try {
      const updates = {};
      updates[`users/${this.userId}/categories/${id}`] = null;
      const tasksToMove = this.tasks.filter(t => t.categoryId === id);
      tasksToMove.forEach(t => {
        updates[`users/${this.userId}/tasks/${t.id}/categoryId`] = defaultCatId;
      });
      await update(ref(db), updates);
    } catch (e) {
      console.error("Error deleting category:", e);
    }
  }

  getFilteredTasks() {
    return this.tasks.filter(task => {
      const matchCat = this.selectedCategoryId === 'all' || task.categoryId === this.selectedCategoryId;
      const matchStatus = this.selectedStatusFilter === 'all' || 
                          (this.selectedStatusFilter === 'active' && !task.completed) ||
                          (this.selectedStatusFilter === 'completed' && task.completed);
      return matchCat && matchStatus;
    });
  }

  getStats() {
    const relevantTasks = this.selectedCategoryId === 'all' 
      ? this.tasks 
      : this.tasks.filter(t => t.categoryId === this.selectedCategoryId);

    const total = relevantTasks.length;
    const completed = relevantTasks.filter(t => t.completed).length;
    const active = total - completed;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, active, percentage };
  }

  getActiveCountForCategory(catId) {
    return this.tasks.filter(t => t.categoryId === catId && !t.completed).length;
  }
}

// ==========================================================================
// 4. UI & CONTROLLER LAYER (AppController)
// ==========================================================================
class AppController {
  constructor(store) {
    this.store = store;
    this.authMode = 'login';

    this.elements = {
      sidebar: document.getElementById('sidebar'),
      viewsList: document.getElementById('views-list'),
      categoryList: document.getElementById('category-list'),
      btnAddCategory: document.getElementById('btn-add-category'),
      currentDate: document.getElementById('current-date'),
      mobileMenuToggle: document.getElementById('mobile-menu-toggle'),
      mobileDate: document.getElementById('mobile-date'),
      progressPercentage: document.getElementById('progress-percentage'),
      progressBarFill: document.getElementById('progress-bar-fill'),
      progressCompleted: document.getElementById('progress-completed'),
      progressRemaining: document.getElementById('progress-remaining'),
      taskForm: document.getElementById('task-form'),
      taskInput: document.getElementById('task-input'),
      taskCategoryBtn: document.getElementById('task-category-btn'),
      taskCategoryDropdown: document.getElementById('task-category-dropdown'),
      filterAll: document.getElementById('filter-all'),
      filterActive: document.getElementById('filter-active'),
      filterCompleted: document.getElementById('filter-completed'),
      activeCountBadge: document.getElementById('active-count-badge'),
      tasksList: document.getElementById('tasks-list'),
      emptyState: document.getElementById('empty-state'),
      categoryModal: document.getElementById('category-modal'),
      btnCloseModal: document.getElementById('btn-close-modal'),
      categoryForm: document.getElementById('category-form'),
      categoryNameInput: document.getElementById('category-name-input'),
      colorPalette: document.getElementById('category-color-palette'),
      themeToggleDesktop: document.getElementById('theme-toggle-desktop'),
      themeToggleMobile: document.getElementById('theme-toggle-mobile'),
      authOverlay: document.getElementById('auth-overlay'),
      tabLogin: document.getElementById('tab-login'),
      tabRegister: document.getElementById('tab-register'),
      authForm: document.getElementById('auth-form'),
      authEmail: document.getElementById('auth-email'),
      authPassword: document.getElementById('auth-password'),
      authSubmitBtn: document.getElementById('auth-submit-btn'),
      authErrorMsg: document.getElementById('auth-error-msg'),
      btnGoogleAuth: document.getElementById('btn-google-auth'),
      btnLogout: document.getElementById('btn-logout'),
      loadingOverlay: document.getElementById('loading-overlay'),
      userProfileSection: document.getElementById('user-profile-section'),
      userAvatar: document.getElementById('user-avatar'),
      userAvatarPlaceholder: document.getElementById('user-avatar-placeholder'),
      userName: document.getElementById('user-name'),
      userEmail: document.getElementById('user-email')
    };

    this.selectedModalColor = '#F0521D';
    this.editingCategoryId = null;

    this.init();
  }

  init() {
    this.applyTheme(this.store.theme);
    this.setupDate();
    this.setupEventListeners();
    this.setupAuthListener();
  }

  setupDate() {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    const today = new Date();
    this.elements.currentDate.textContent = `${days[today.getDay()]} , ${months[today.getMonth()]} ${today.getDate()}`;
    this.elements.mobileDate.textContent = `${months[today.getMonth()]} ${today.getDate()}`;
  }

  setupEventListeners() {
    this.elements.taskForm.addEventListener('submit', (e) => this.handleAddTask(e));

    this.elements.taskCategoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.elements.taskCategoryDropdown.classList.toggle('show');
    });

    document.addEventListener('click', () => {
      this.elements.taskCategoryDropdown.classList.remove('show');
    });

    this.elements.filterAll.addEventListener('click', () => this.handleStatusFilterChange('all'));
    this.elements.filterActive.addEventListener('click', () => this.handleStatusFilterChange('active'));
    this.elements.filterCompleted.addEventListener('click', () => this.handleStatusFilterChange('completed'));

    this.elements.btnAddCategory.addEventListener('click', () => this.setModalVisible(true));
    this.elements.btnCloseModal.addEventListener('click', () => this.setModalVisible(false));
    this.elements.categoryModal.addEventListener('click', (e) => {
      if (e.target === this.elements.categoryModal) this.setModalVisible(false);
    });

    this.elements.colorPalette.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (swatch) {
        this.elements.colorPalette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        this.selectedModalColor = swatch.dataset.color;
      }
    });

    this.elements.categoryForm.addEventListener('submit', (e) => this.handleAddCategory(e));

    this.elements.mobileMenuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.elements.sidebar.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (window.innerWidth <= 900 && !this.elements.sidebar.contains(e.target) && e.target !== this.elements.mobileMenuToggle) {
        this.elements.sidebar.classList.remove('open');
      }
    });

    if (this.elements.themeToggleDesktop) this.elements.themeToggleDesktop.addEventListener('click', () => this.handleThemeToggle());
    if (this.elements.themeToggleMobile) this.elements.themeToggleMobile.addEventListener('click', () => this.handleThemeToggle());

    this.elements.tabLogin.addEventListener('click', () => this.switchAuthMode('login'));
    this.elements.tabRegister.addEventListener('click', () => this.switchAuthMode('register'));
    this.elements.authForm.addEventListener('submit', (e) => this.handleAuthSubmit(e));
    this.elements.btnGoogleAuth.addEventListener('click', () => this.handleGoogleAuth());
    this.elements.btnLogout.addEventListener('click', () => this.handleLogout());
  }

  // ==========================================================================
  // AUTHENTICATION CONTROLLER FLOWS
  // ==========================================================================
  setupAuthListener() {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        this.elements.loadingOverlay.style.display = 'flex';
        this.elements.loadingOverlay.style.opacity = '1';

        let catsLoaded = false;
        let tksLoaded = false;

        const checkSync = () => {
          if (catsLoaded && tksLoaded) {
            this.elements.authOverlay.style.opacity = '0';
            this.elements.loadingOverlay.style.opacity = '0';
            setTimeout(() => {
              this.elements.authOverlay.style.display = 'none';
              this.elements.loadingOverlay.style.display = 'none';
            }, 150); 

            this.elements.userEmail.textContent = user.email;
            const displayName = user.displayName || user.email.split('@')[0];
            this.elements.userName.textContent = displayName;

            if (user.photoURL) {
              this.elements.userAvatar.src = user.photoURL;
              this.elements.userAvatar.style.display = 'block';
              this.elements.userAvatarPlaceholder.style.display = 'none';
            } else {
              this.elements.userAvatar.style.display = 'none';
              this.elements.userAvatarPlaceholder.textContent = displayName.charAt(0);
              this.elements.userAvatarPlaceholder.style.display = 'flex';
            }
            this.elements.userProfileSection.style.display = 'flex';

            this.setAuthFormLoading(false);
            this.render();
          }
        };

        this.store.onUpdate = () => this.render();

        this.store.bindUser(user.uid, {
          onCategoriesSynced: () => { catsLoaded = true; checkSync(); },
          onTasksSynced: () => { tksLoaded = true; checkSync(); }
        });
      } else {
        this.store.unbindUser();
        this.elements.userProfileSection.style.display = 'none';
        this.elements.authOverlay.style.display = 'flex';
        this.elements.authOverlay.style.opacity = '1';
        this.elements.loadingOverlay.style.display = 'none';
        this.render();
      }
    });
  }

  switchAuthMode(mode) {
    this.authMode = mode;
    this.elements.authErrorMsg.style.display = 'none';
    this.elements.authErrorMsg.textContent = '';
    
    this.elements.tabLogin.classList.toggle('active', mode === 'login');
    this.elements.tabRegister.classList.toggle('active', mode === 'register');
    this.elements.authSubmitBtn.textContent = mode === 'login' ? 'Log In' : 'Sign Up';
    this.elements.authPassword.placeholder = mode === 'login' ? '••••••••' : 'At least 6 characters';
  }

  async handleAuthSubmit(e) {
    e.preventDefault();
    const email = this.elements.authEmail.value.trim();
    const password = this.elements.authPassword.value;

    if (!email || !password) return;
    this.setAuthFormLoading(true);

    try {
      if (this.authMode === 'login') {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        if (password.length < 6) {
          throw { code: 'auth/weak-password', message: 'Password should be at least 6 characters.' };
        }
        await createUserWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      console.error("Auth error:", err);
      this.showAuthError(err.code || 'unknown', err.message);
      this.setAuthFormLoading(false);
    }
  }

  async handleGoogleAuth() {
    this.elements.authErrorMsg.style.display = 'none';
    this.setAuthFormLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Google Auth error:", err);
      this.setAuthFormLoading(false);
      if (err.code !== 'auth/popup-closed-by-user') {
        this.showAuthError(err.code || 'unknown', err.message);
      }
    }
  }

  async handleLogout() {
    if (confirm("Are you sure you want to log out?")) {
      this.elements.loadingOverlay.style.display = 'flex';
      this.elements.loadingOverlay.style.opacity = '1';
      try {
        await signOut(auth);
      } catch (err) {
        console.error("Logout error:", err);
        this.elements.loadingOverlay.style.display = 'none';
      }
    }
  }

  setAuthFormLoading(loading) {
    this.elements.authEmail.disabled = loading;
    this.elements.authPassword.disabled = loading;
    this.elements.authSubmitBtn.disabled = loading;
    this.elements.btnGoogleAuth.disabled = loading;

    if (loading) {
      this.elements.authSubmitBtn.textContent = this.authMode === 'login' ? 'Logging In...' : 'Signing Up...';
      this.elements.authSubmitBtn.style.opacity = '0.7';
    } else {
      this.elements.authSubmitBtn.textContent = this.authMode === 'login' ? 'Log In' : 'Sign Up';
      this.elements.authSubmitBtn.style.opacity = '1';
    }
  }

  showAuthError(code, message) {
    let friendlyMsg = message;
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/invalid-email':
      case 'auth/user-not-found':
      case 'auth/wrong-password':
        friendlyMsg = 'Invalid email address or password. Please try again.';
        break;
      case 'auth/email-already-in-use':
        friendlyMsg = 'This email address is already in use by another account.';
        break;
      case 'auth/weak-password':
        friendlyMsg = 'Password is too weak. It must be at least 6 characters.';
        break;
    }
    this.elements.authErrorMsg.textContent = friendlyMsg;
    this.elements.authErrorMsg.style.display = 'block';
  }

  // ==========================================================================
  // TO-DO LOGIC ACTION HANDLERS
  // ==========================================================================
  handleAddTask(e) {
    e.preventDefault();
    const text = this.elements.taskInput.value.trim();
    if (!text) return;

    this.store.addTask(text, this.store.newTaskCategoryId);
    this.elements.taskInput.value = '';
    this.elements.taskInput.focus();
  }

  handleAddCategory(e) {
    e.preventDefault();
    const name = this.elements.categoryNameInput.value.trim();
    if (!name) return;

    if (this.editingCategoryId) {
      this.store.updateCategory(this.editingCategoryId, name, this.selectedModalColor);
      this.editingCategoryId = null;
    } else {
      this.store.addCategory(name, this.selectedModalColor);
    }
    this.elements.categoryNameInput.value = '';
    this.setModalVisible(false);
  }

  handleStatusFilterChange(status) {
    this.store.selectedStatusFilter = status;
    this.store.save(this.store.STORAGE_KEYS.SELECTED_STATUS, status);
    
    this.elements.filterAll.classList.toggle('active', status === 'all');
    this.elements.filterActive.classList.toggle('active', status === 'active');
    this.elements.filterCompleted.classList.toggle('active', status === 'completed');

    this.render();
  }

  handleCategoryFilterChange(catId) {
    this.store.selectedCategoryId = catId;
    this.store.save(this.store.STORAGE_KEYS.SELECTED_CAT, catId);
    
    if (catId !== 'all') this.store.newTaskCategoryId = catId;
    this.elements.sidebar.classList.remove('open'); 
    this.render();
  }

  handleToggleTask(id) {
    this.store.toggleTask(id);
  }

  handleDeleteTask(id, taskElement) {
    taskElement.classList.add('removing');
    taskElement.addEventListener('animationend', () => {
      this.store.deleteTask(id);
    }, { once: true });
  }

  handleEditCategory(catId) {
    const cat = this.store.getCategoryById(catId);
    if (!cat) return;

    this.editingCategoryId = cat.id;
    this.selectedModalColor = cat.color;
    this.elements.categoryNameInput.value = cat.name;
    
    this.elements.categoryModal.querySelector('.modal-title').textContent = 'Edit Category';
    this.elements.categoryModal.querySelector('.modal-submit-btn').textContent = 'Save Changes';

    this.elements.colorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
      swatch.classList.toggle('active', swatch.dataset.color === cat.color);
    });

    this.setModalVisible(true);
  }

  handleDeleteCategory(catId) {
    // Completely removed the alert blocking you from deleting your last category!
    const activeCategories = this.store.categories.filter(c => c.id !== catId);
    const defaultCatId = activeCategories.length > 0 ? activeCategories[0].id : 'uncategorized';

    if (confirm(`Are you sure you want to delete this category? Any tasks inside will be kept as Uncategorized.`)) {
      if (this.store.selectedCategoryId === catId) {
        this.store.selectedCategoryId = 'all';
        this.store.save(this.store.STORAGE_KEYS.SELECTED_CAT, 'all');
      }
      if (this.store.newTaskCategoryId === catId) {
        this.store.newTaskCategoryId = defaultCatId;
      }
      this.store.deleteCategory(catId);
    }
  }

  setModalVisible(visible) {
    this.elements.categoryModal.classList.toggle('show', visible);
    this.elements.categoryModal.setAttribute('aria-hidden', !visible);
    if (visible) {
      this.elements.categoryNameInput.focus();
    } else {
      this.editingCategoryId = null;
      this.elements.categoryNameInput.value = '';
      this.elements.categoryModal.querySelector('.modal-title').textContent = 'New Category';
      this.elements.categoryModal.querySelector('.modal-submit-btn').textContent = 'Create Category';
      
      const defaultColor = '#F0521D';
      this.selectedModalColor = defaultColor;
      this.elements.colorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.classList.toggle('active', swatch.dataset.color === defaultColor);
      });
    }
  }

  applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);

    const sunIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    const moonIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
    const activeIcon = isDark ? sunIcon : moonIcon;

    if (this.elements.themeToggleDesktop) this.elements.themeToggleDesktop.innerHTML = activeIcon;
    if (this.elements.themeToggleMobile) this.elements.themeToggleMobile.innerHTML = activeIcon;
  }

  handleThemeToggle() {
    const newTheme = this.store.theme === 'dark' ? 'light' : 'dark';
    this.store.setTheme(newTheme);
    this.applyTheme(newTheme);
  }

  render() {
    this.renderSidebarCategories();
    this.renderInputCategorySelector();
    this.renderDashboardStats();
    this.renderTaskList();
  }

  renderSidebarCategories() {
    const viewsList = this.elements.viewsList;
    viewsList.innerHTML = '';

    const allLi = document.createElement('li');
    allLi.className = 'views-item';
    
    // FIX: "All Tasks" badge now strictly counts ALL tasks (completed and uncompleted)
    const totalTasksCount = this.store.tasks.length;
    const isAllActive = this.store.selectedCategoryId === 'all';
    
    allLi.innerHTML = `
      <button class="category-btn ${isAllActive ? 'active' : ''}">
        <span class="category-info">
          <svg xmlns="http://www.w3.org/2000/svg" class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
          <span>All Tasks</span>
        </span>
        <span class="category-count">${totalTasksCount}</span>
      </button>
    `;
    allLi.querySelector('button').addEventListener('click', () => this.handleCategoryFilterChange('all'));
    viewsList.appendChild(allLi);

    const list = this.elements.categoryList;
    list.innerHTML = '';

    this.store.categories.forEach(cat => {
      const li = document.createElement('li');
      li.className = 'category-item';
      const count = this.store.getActiveCountForCategory(cat.id);
      const isActive = this.store.selectedCategoryId === cat.id;

      li.innerHTML = `
        <div class="category-item-container">
          <button class="category-btn ${isActive ? 'active' : ''}">
            <span class="category-info">
              <span class="category-dot" style="background-color: ${cat.color};"></span>
              <span>${this.escapeHTML(cat.name)}</span>
            </span>
            <span class="category-count">${count}</span>
          </button>
          <div class="category-actions">
            <button class="btn-edit-category" title="Edit Category">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
            <button class="btn-delete-category" title="Delete Category">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </div>
      `;

      li.querySelector('.category-btn').addEventListener('click', () => this.handleCategoryFilterChange(cat.id));
      li.querySelector('.btn-edit-category').addEventListener('click', (e) => { e.stopPropagation(); this.handleEditCategory(cat.id); });
      li.querySelector('.btn-delete-category').addEventListener('click', (e) => { e.stopPropagation(); this.handleDeleteCategory(cat.id); });
      list.appendChild(li);
    });
  }

  renderInputCategorySelector() {
    const activeCat = this.store.getCategoryById(this.store.newTaskCategoryId) || { name: 'Uncategorized', color: '#6B7280' };
    
    if (activeCat) {
      this.elements.taskCategoryBtn.querySelector('.selected-category-dot').style.backgroundColor = activeCat.color;
      this.elements.taskCategoryBtn.querySelector('.selected-category-name').textContent = activeCat.name;
    }

    const dropdown = this.elements.taskCategoryDropdown;
    dropdown.innerHTML = '';

    this.store.categories.forEach(cat => {
      const li = document.createElement('li');
      li.className = 'dropdown-item';
      li.innerHTML = `
        <button type="button" class="dropdown-btn">
          <span class="selected-category-dot" style="background-color: ${cat.color};"></span>
          <span>${this.escapeHTML(cat.name)}</span>
        </button>
      `;

      li.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        this.store.newTaskCategoryId = cat.id;
        dropdown.classList.remove('show');
        this.renderInputCategorySelector();
      });
      dropdown.appendChild(li);
    });

    // Provide an "Uncategorized" selection choice if all categories are deleted
    if (this.store.categories.length === 0) {
      const li = document.createElement('li');
      li.className = 'dropdown-item';
      li.innerHTML = `
        <button type="button" class="dropdown-btn">
          <span class="selected-category-dot" style="background-color: #6B7280;"></span>
          <span>Uncategorized</span>
        </button>
      `;
      li.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        this.store.newTaskCategoryId = 'uncategorized';
        dropdown.classList.remove('show');
        this.renderInputCategorySelector();
      });
      dropdown.appendChild(li);
    }
  }

  renderDashboardStats() {
    const stats = this.store.getStats();
    this.elements.progressBarFill.style.width = `${stats.percentage}%`;
    this.elements.progressPercentage.textContent = `${stats.percentage}%`;
    this.elements.progressCompleted.textContent = `${stats.completed} completed`;
    this.elements.progressRemaining.textContent = `${stats.active} remaining`;
    this.elements.activeCountBadge.textContent = stats.active;
  }

  renderTaskList() {
    const list = this.elements.tasksList;
    const filteredTasks = this.store.getFilteredTasks();
    list.innerHTML = '';

    if (filteredTasks.length === 0) {
      this.elements.emptyState.style.display = 'flex';
      list.style.display = 'none';
      return;
    }

    this.elements.emptyState.style.display = 'none';
    list.style.display = 'flex';

    const createTaskElement = (task) => {
      const li = document.createElement('li');
      li.className = `task-item ${task.completed ? 'completed' : ''}`;
      li.id = task.id;

      // Provide "Uncategorized" styling if category doesn't exist anymore
      const category = this.store.getCategoryById(task.categoryId) || { name: 'Uncategorized', color: '#6B7280' };
      const completedDateStamp = task.completed && task.completedAt ? `<span class="task-completed-date">Completed on ${this.formatCompletionDate(task.completedAt)}</span>` : '';

      li.innerHTML = `
        <div class="task-left">
          <label class="checkbox-container">
            <input type="checkbox" ${task.completed ? 'checked' : ''}>
            <span class="checkmark">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          </label>
          <div class="task-text-container">
            <span class="task-content">${this.escapeHTML(task.text)}</span>
            ${completedDateStamp}
          </div>
        </div>
        <div class="task-right">
          <span class="task-category-tag" style="color: ${category.color}; background-color: ${category.color}15; border-color: ${category.color}30;">
            ${this.escapeHTML(category.name)}
          </span>
          <button class="btn-delete-task" title="Delete Task">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;

      li.querySelector('input[type="checkbox"]').addEventListener('change', () => this.handleToggleTask(task.id));
      li.querySelector('.btn-delete-task').addEventListener('click', () => this.handleDeleteTask(task.id, li));
      return li;
    };

    if (this.store.selectedCategoryId === 'all') {
      const renderedCatIds = new Set();
      
      this.store.categories.forEach(cat => {
        const catTasks = filteredTasks.filter(t => t.categoryId === cat.id);
        if (catTasks.length > 0) {
          renderedCatIds.add(cat.id);
          const header = document.createElement('div');
          header.className = 'task-list-category-header';
          header.innerHTML = `<span class="task-list-category-dot" style="background-color: ${cat.color};"></span><span>${this.escapeHTML(cat.name)}</span>`;
          list.appendChild(header);

          const pending = catTasks.filter(t => !t.completed);
          const completed = catTasks.filter(t => t.completed);

          pending.forEach(t => list.appendChild(createTaskElement(t)));
          if (pending.length > 0 && completed.length > 0) {
            const div = document.createElement('div'); div.className = 'category-completed-divider'; div.textContent = 'Completed';
            list.appendChild(div);
          }
          completed.forEach(t => list.appendChild(createTaskElement(t)));
        }
      });

      // FIX: Ensures tasks with a deleted category stay visible under "Uncategorized" instead of vanishing!
      const orphanedTasks = filteredTasks.filter(t => !renderedCatIds.has(t.categoryId));
      if (orphanedTasks.length > 0) {
        const cat = { name: 'Uncategorized', color: '#6B7280' };
        const header = document.createElement('div');
        header.className = 'task-list-category-header';
        header.innerHTML = `<span class="task-list-category-dot" style="background-color: ${cat.color};"></span><span>${this.escapeHTML(cat.name)}</span>`;
        list.appendChild(header);

        const pending = orphanedTasks.filter(t => !t.completed);
        const completed = orphanedTasks.filter(t => t.completed);

        pending.forEach(t => list.appendChild(createTaskElement(t)));
        if (pending.length > 0 && completed.length > 0) {
          const div = document.createElement('div'); div.className = 'category-completed-divider'; div.textContent = 'Completed';
          list.appendChild(div);
        }
        completed.forEach(t => list.appendChild(createTaskElement(t)));
      }

    } else {
      const pending = filteredTasks.filter(t => !t.completed);
      const completed = filteredTasks.filter(t => t.completed);
      pending.forEach(t => list.appendChild(createTaskElement(t)));
      if (pending.length > 0 && completed.length > 0) {
        const div = document.createElement('div'); div.className = 'category-completed-divider'; div.textContent = 'Completed';
        list.appendChild(div);
      }
      completed.forEach(t => list.appendChild(createTaskElement(t)));
    }
  }

  formatCompletionDate(isoString) {
    if (!isoString) return '';
    try {
      const date = new Date(isoString);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    } catch (e) { return ''; }
  }

  escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
}

// ==========================================================================
// 5. APPLICATION BOOTSTRAP
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  const store = new TaskStore();
  window.tasklyApp = new AppController(store);
});
