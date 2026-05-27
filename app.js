/**
 * Taskly - Premium To-Do & Task Management with Firebase Sync
 * This file contains the complete application logic, state management,
 * and database integration for the Taskly frontend.
 */

// 1. IMPORT FIREBASE DEPENDENCIES FROM GOOGLE CDN
// We import individual modular functions rather than loading the entire bulky SDK.
// This optimizes performance and follows modern ES Module standards.
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
// This configuration links our application code to the Taskly Firebase project.
const firebaseConfig = {
  projectId: "taskly-todo-47295",
  appId: "1:673275166379:web:c437182c5ca65bfe4e01ee",
  storageBucket: "taskly-todo-47295.firebasestorage.app",
  apiKey: "AIzaSyAuev7wMFDXOxq5UIEtGPud0_NPjnUqYBE",
  authDomain: "taskly-todo-47295.firebaseapp.com",
  messagingSenderId: "673275166379",
  measurementId: "G-XMHZC8G4X3",
  databaseURL: "https://taskly-todo-47295-default-rtdb.firebaseio.com"
};

// Initialize Firebase Core, Auth services, and the Realtime Database instance
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ==========================================================================
// 3. STATE MANAGEMENT & DATA MODELS (TaskStore)
// ==========================================================================
// This class manages the application's underlying data. It handles database
// listeners, processes CRUD operations, and manages local device preferences.
class TaskStore {
  constructor() {
    // Keys used to save/load non-synchronized user preferences from local storage
    this.STORAGE_KEYS = {
      SELECTED_CAT: 'taskly_selected_category', // Active category filter (e.g. 'work' or 'all')
      SELECTED_STATUS: 'taskly_selected_status', // Active status tab filter (e.g. 'all', 'active', 'completed')
      THEME: 'taskly_theme'                     // Active theme preference ('light' or 'dark')
    };

    // Load device-specific filter and theme preferences from LocalStorage
    this.selectedCategoryId = this.load(this.STORAGE_KEYS.SELECTED_CAT) || 'all';
    this.selectedStatusFilter = this.load(this.STORAGE_KEYS.SELECTED_STATUS) || 'all';
    this.theme = this.load(this.STORAGE_KEYS.THEME) || 'light';

    // In-memory containers populated and synced in real-time from Realtime Database
    this.categories = []; // User categories list
    this.tasks = [];      // User tasks list

    // Keep track of the currently logged-in user's UID and the controller refresh callback
    this.userId = null;
    this.onUpdate = null; // Called whenever database data updates to refresh the UI
    
    // Tracks the active category selected in the new task creation dropdown
    this.newTaskCategoryId = 'work';

    // Holds the listener unsubscribers. Calling these turns off the real-time sync.
    this.unsubscribeCategories = null;
    this.unsubscribeTasks = null;
  }

  // Helper: Save preference state to browser local storage
  save(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  // Helper: Retrieve preference state from browser local storage
  load(key) {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : null;
  }

  // Updates the light/dark theme preference and saves it to local storage
  setTheme(theme) {
    this.theme = theme;
    this.save(this.STORAGE_KEYS.THEME, theme);
  }

  // Binds the active authenticated user to real-time database endpoints
  bindUser(userId, callbacks) {
    this.userId = userId;
    this.unbindUser(); // Safeguard: turn off any previous listeners first
    this.userId = userId;

    // A. Sync User Categories
    // Location: users/{userId}/categories
    const categoriesRef = ref(db, `users/${userId}/categories`);
    this.unsubscribeCategories = onValue(categoriesRef, async (snapshot) => {
      const data = snapshot.val();
      let cats = [];
      if (data) {
        // Realtime Database returns nested nodes as objects. We convert them to an array
        // and map the node keys as the document ID.
        Object.keys(data).forEach(key => {
          cats.push({
            id: key,
            ...data[key]
          });
        });
      }

      // If a brand new user logs in and has no categories, initialize default ones
      if (cats.length === 0) {
        await this.initializeDefaultCategories();
        return; // The database update will automatically trigger this listener again
      }

      // Sort categories chronologically by creation timestamp to ensure stable layout order
      cats.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      this.categories = cats;
      
      // Safety Checks: Fallback selections if categories were deleted or not loaded
      const defaultCatId = this.categories.length > 0 ? this.categories[0].id : 'work';
      if (!this.categories.some(c => c.id === this.newTaskCategoryId)) {
        this.newTaskCategoryId = defaultCatId;
      }
      if (this.selectedCategoryId !== 'all' && !this.categories.some(c => c.id === this.selectedCategoryId)) {
        this.selectedCategoryId = 'all';
      }

      // Fire UI update
      if (this.onUpdate) this.onUpdate();

      // Trigger the initial sync complete callback (if configured)
      if (callbacks && callbacks.onCategoriesSynced) {
        callbacks.onCategoriesSynced();
        callbacks.onCategoriesSynced = null; // Reset to call only once
      }
    }, (error) => {
      console.error("Database categories sync error:", error);
    });

    // B. Sync User Tasks
    // Location: users/{userId}/tasks
    const tasksRef = ref(db, `users/${userId}/tasks`);
    this.unsubscribeTasks = onValue(tasksRef, (snapshot) => {
      const data = snapshot.val();
      let tks = [];
      if (data) {
        // Convert the nested task objects into an array, mapping object keys to task IDs
        Object.keys(data).forEach(key => {
          tks.push({
            id: key,
            ...data[key]
          });
        });
      }

      // Sort tasks chronologically by creation time
      tks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      this.tasks = tks;

      // Fire UI update
      if (this.onUpdate) this.onUpdate();

      // Trigger initial task sync callback
      if (callbacks && callbacks.onTasksSynced) {
        callbacks.onTasksSynced();
        callbacks.onTasksSynced = null; // Reset to call only once
      }
    }, (error) => {
      console.error("Database tasks sync error:", error);
    });
  }

  // Unbinds the user session and turns off active database listeners
  unbindUser() {
    if (this.unsubscribeCategories) {
      this.unsubscribeCategories(); // Detach categories listener
      this.unsubscribeCategories = null;
    }
    if (this.unsubscribeTasks) {
      this.unsubscribeTasks();       // Detach tasks listener
      this.unsubscribeTasks = null;
    }
    this.userId = null;
    this.tasks = [];
    this.categories = [];
  }

  // Pre-populates default categories (Work, Personal, Shopping) for new user accounts
  async initializeDefaultCategories() {
    if (!this.userId) return;
    const defaults = {
      work: { name: 'Work', color: '#3B82F6', createdAt: Date.now() },
      personal: { name: 'Personal', color: '#8B5CF6', createdAt: Date.now() + 1 },
      shopping: { name: 'Shopping', color: '#EC4899', createdAt: Date.now() + 2 }
    };

    try {
      // Set the default categories object directly in the database path
      await set(ref(db, `users/${this.userId}/categories`), defaults);
    } catch (e) {
      console.error("Error creating default categories:", e);
    }
  }

  // Add a task to users/{userId}/tasks/{taskId}
  async addTask(text, categoryId) {
    if (!text.trim() || !this.userId) return;
    const defaultCatId = this.categories.length > 0 ? this.categories[0].id : 'work';
    const tasksRef = ref(db, `users/${this.userId}/tasks`);
    
    // push() generates a unique push ID (e.g. -NyH2j...) in the database path
    const newTaskRef = push(tasksRef);

    const newTask = {
      text: text.trim(),
      completed: false,
      categoryId: categoryId || defaultCatId,
      createdAt: Date.now()
    };

    try {
      await set(newTaskRef, newTask);
    } catch (e) {
      console.error("Error saving task to Database:", e);
    }
  }

  // Delete a task from users/{userId}/tasks/{taskId}
  async deleteTask(id) {
    if (!this.userId) return;
    try {
      await remove(ref(db, `users/${this.userId}/tasks/${id}`));
    } catch (e) {
      console.error("Error deleting task from Database:", e);
    }
  }

  // Toggles the checked status of a task, storing the completion date if completed
  async toggleTask(id) {
    if (!this.userId) return;
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      const completed = !task.completed;
      const updates = { completed: completed };
      if (completed) {
        updates.completedAt = new Date().toISOString();
      } else {
        updates.completedAt = null; // Wipes timestamp if task is unchecked
      }

      try {
        await update(ref(db, `users/${this.userId}/tasks/${id}`), updates);
      } catch (e) {
        console.error("Error updating task status:", e);
      }
    }
  }

  // Create a custom category under users/{userId}/categories/{categoryId}
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

  // Lookup helper for category object details
  getCategoryById(id) {
    return this.categories.find(c => c.id === id);
  }

  // Updates a category's swatch name or color hex code
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

  // Deletes a category and atomically moves its associated tasks to the default fallback category
  async deleteCategory(id) {
    if (id === 'all' || !this.userId) return;
    
    // Choose fallback category (first available category excluding the one being deleted)
    const activeCategories = this.categories.filter(c => c.id !== id);
    const defaultCatId = activeCategories.length > 0 ? activeCategories[0].id : 'work';

    try {
      const updates = {};
      // Set category node to null to delete it
      updates[`users/${this.userId}/categories/${id}`] = null;
      
      // Update each associated task's categoryId to point to the default category fallback
      const tasksToMove = this.tasks.filter(t => t.categoryId === id);
      tasksToMove.forEach(t => {
        updates[`users/${this.userId}/tasks/${t.id}/categoryId`] = defaultCatId;
      });

      // Submit all changes in a single atomic network request
      await update(ref(db), updates);
    } catch (e) {
      console.error("Error deleting category & migrating tasks:", e);
    }
  }

  // Filters the synced tasks in memory to match the active view and category filters
  getFilteredTasks() {
    return this.tasks.filter(task => {
      const matchCat = this.selectedCategoryId === 'all' || task.categoryId === this.selectedCategoryId;
      const matchStatus = this.selectedStatusFilter === 'all' || 
                          (this.selectedStatusFilter === 'active' && !task.completed) ||
                          (this.selectedStatusFilter === 'completed' && task.completed);
      return matchCat && matchStatus;
    });
  }

  // Calculates completion rates and percentage metrics for the active view
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

  // Retrieves the count of uncompleted tasks inside a specific category
  getActiveCountForCategory(catId) {
    return this.tasks.filter(t => t.categoryId === catId && !t.completed).length;
  }
}

// ==========================================================================
// 4. UI & CONTROLLER LAYER (AppController)
// ==========================================================================
// This class manages DOM interactions, captures browser inputs, handles forms,
// triggers database operations in the TaskStore, and handles user authentication.
class AppController {
  constructor(store) {
    this.store = store;
    this.authMode = 'login'; // Tracks active auth form panel ('login' or 'register')

    // Cache DOM Elements to avoid repetitive and expensive querySelector calls
    this.elements = {
      // Sidebar Elements
      sidebar: document.getElementById('sidebar'),
      viewsList: document.getElementById('views-list'),
      categoryList: document.getElementById('category-list'),
      btnAddCategory: document.getElementById('btn-add-category'),
      currentDate: document.getElementById('current-date'),

      // Mobile Header Elements
      mobileMenuToggle: document.getElementById('mobile-menu-toggle'),
      mobileDate: document.getElementById('mobile-date'),

      // Dashboard Progress Card Elements
      progressPercentage: document.getElementById('progress-percentage'),
      progressBarFill: document.getElementById('progress-bar-fill'),
      progressCompleted: document.getElementById('progress-completed'),
      progressRemaining: document.getElementById('progress-remaining'),

      // Task Input bar Elements
      taskForm: document.getElementById('task-form'),
      taskInput: document.getElementById('task-input'),
      taskCategoryBtn: document.getElementById('task-category-btn'),
      taskCategoryDropdown: document.getElementById('task-category-dropdown'),

      // Status Tab Filters
      filterAll: document.getElementById('filter-all'),
      filterActive: document.getElementById('filter-active'),
      filterCompleted: document.getElementById('filter-completed'),
      activeCountBadge: document.getElementById('active-count-badge'),

      // Task List Elements
      tasksList: document.getElementById('tasks-list'),
      emptyState: document.getElementById('empty-state'),

      // Category Swatch Modal
      categoryModal: document.getElementById('category-modal'),
      btnCloseModal: document.getElementById('btn-close-modal'),
      categoryForm: document.getElementById('category-form'),
      categoryNameInput: document.getElementById('category-name-input'),
      colorPalette: document.getElementById('category-color-palette'),

      // Theme toggle buttons
      themeToggleDesktop: document.getElementById('theme-toggle-desktop'),
      themeToggleMobile: document.getElementById('theme-toggle-mobile'),

      // Auth Panels & Inputs
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

      // System Loading Screen
      loadingOverlay: document.getElementById('loading-overlay'),

      // Sidebar Profile Info
      userProfileSection: document.getElementById('user-profile-section'),
      userAvatar: document.getElementById('user-avatar'),
      userAvatarPlaceholder: document.getElementById('user-avatar-placeholder'),
      userName: document.getElementById('user-name'),
      userEmail: document.getElementById('user-email')
    };

    this.selectedModalColor = '#F0521D'; // Active color in modal swatches palette (defaults to accent orange)
    this.editingCategoryId = null;       // Tracks which category is being edited (null = new category mode)

    this.init();
  }

  // Bootstrap application subsystems
  init() {
    this.applyTheme(this.store.theme);
    this.setupDate();
    this.setupEventListeners();
    this.setupAuthListener();
  }

  // Formats and displays the current date (Wednesday, May 27)
  setupDate() {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    
    const today = new Date();
    const dayName = days[today.getDay()];
    const monthName = months[today.getMonth()];
    const dateNum = today.getDate();

    this.elements.currentDate.textContent = `${dayName}, ${monthName} ${dateNum}`;
    this.elements.mobileDate.textContent = `${monthName} ${dateNum}`;
  }

  // Setup event listeners for user input controls
  setupEventListeners() {
    // Task Input Submit
    this.elements.taskForm.addEventListener('submit', (e) => this.handleAddTask(e));

    // Category Selector Toggle (inside task input bar)
    this.elements.taskCategoryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.elements.taskCategoryDropdown.classList.toggle('show');
    });

    // Close Category dropdown if user clicks outside of it
    document.addEventListener('click', () => {
      this.elements.taskCategoryDropdown.classList.remove('show');
    });

    // Status Filter Tabs
    this.elements.filterAll.addEventListener('click', () => this.handleStatusFilterChange('all'));
    this.elements.filterActive.addEventListener('click', () => this.handleStatusFilterChange('active'));
    this.elements.filterCompleted.addEventListener('click', () => this.handleStatusFilterChange('completed'));

    // Category Swatch Modal triggers
    this.elements.btnAddCategory.addEventListener('click', () => this.setModalVisible(true));
    this.elements.btnCloseModal.addEventListener('click', () => this.setModalVisible(false));
    this.elements.categoryModal.addEventListener('click', (e) => {
      if (e.target === this.elements.categoryModal) this.setModalVisible(false);
    });

    // Modal color swatch selector click handler
    this.elements.colorPalette.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (swatch) {
        this.elements.colorPalette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        this.selectedModalColor = swatch.dataset.color;
      }
    });

    // Modal Form Submit
    this.elements.categoryForm.addEventListener('submit', (e) => this.handleAddCategory(e));

    // Mobile Sidebar Toggle
    this.elements.mobileMenuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.elements.sidebar.classList.toggle('open');
    });

    // Close Sidebar on outside clicks (mobile view)
    document.addEventListener('click', (e) => {
      if (window.innerWidth <= 900 && !this.elements.sidebar.contains(e.target) && e.target !== this.elements.mobileMenuToggle) {
        this.elements.sidebar.classList.remove('open');
      }
    });

    // Light/Dark Theme Switchers
    if (this.elements.themeToggleDesktop) {
      this.elements.themeToggleDesktop.addEventListener('click', () => this.handleThemeToggle());
    }
    if (this.elements.themeToggleMobile) {
      this.elements.themeToggleMobile.addEventListener('click', () => this.handleThemeToggle());
    }

    // Auth Overlay Panel event bindings
    this.elements.tabLogin.addEventListener('click', () => this.switchAuthMode('login'));
    this.elements.tabRegister.addEventListener('click', () => this.switchAuthMode('register'));
    this.elements.authForm.addEventListener('submit', (e) => this.handleAuthSubmit(e));
    this.elements.btnGoogleAuth.addEventListener('click', () => this.handleGoogleAuth());
    this.elements.btnLogout.addEventListener('click', () => this.handleLogout());
  }

  // ==========================================================================
  // AUTHENTICATION CONTROLLER FLOWS
  // ==========================================================================
  
  // Listens to user auth state shifts (logged in, logged out, or loading)
  setupAuthListener() {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        // User logged in: show the loader screen while we sync the initial database snapshot
        this.elements.loadingOverlay.style.display = 'flex';
        this.elements.loadingOverlay.style.opacity = '1';

        let catsLoaded = false;
        let tksLoaded = false;
        let isInitialSyncCompleted = false;

        // Fades out loaders only after both tasks and categories have fully synchronized
        const checkSync = () => {
          if (catsLoaded && tksLoaded && !isInitialSyncCompleted) {
            isInitialSyncCompleted = true;
            
            // Fade out the Auth overlay panel
            this.elements.authOverlay.style.opacity = '0';
            setTimeout(() => {
              this.elements.authOverlay.style.display = 'none';
            }, 300);

            // Fade out the loading screen
            this.elements.loadingOverlay.style.opacity = '0';
            setTimeout(() => {
              this.elements.loadingOverlay.style.display = 'none';
            }, 300);

            // Populate authenticated profile fields in sidebar footer
            this.elements.userEmail.textContent = user.email;
            const displayName = user.displayName || user.email.split('@')[0];
            this.elements.userName.textContent = displayName;

            if (user.photoURL) {
              // Load user avatar image if using Google Sign-In
              this.elements.userAvatar.src = user.photoURL;
              this.elements.userAvatar.style.display = 'block';
              this.elements.userAvatarPlaceholder.style.display = 'none';
            } else {
              // Fallback to text initials badge for Email Signups
              this.elements.userAvatar.style.display = 'none';
              this.elements.userAvatarPlaceholder.textContent = displayName.charAt(0);
              this.elements.userAvatarPlaceholder.style.display = 'flex';
            }
            this.elements.userProfileSection.style.display = 'flex';

            // Clean inputs and reset form submit loader state
            this.setAuthFormLoading(false);
            this.elements.authEmail.value = '';
            this.elements.authPassword.value = '';
            
            this.render();
          }
        };

        // Connect refresh trigger
        this.store.onUpdate = () => {
          this.render();
        };

        // Bind the store to read/write under this user's UID path
        this.store.bindUser(user.uid, {
          onCategoriesSynced: () => {
            catsLoaded = true;
            checkSync();
          },
          onTasksSynced: () => {
            tksLoaded = true;
            checkSync();
          }
        });
      } else {
        // User logged out: clear memory database nodes, hide profile section, and show Auth page
        this.store.unbindUser();
        this.elements.userProfileSection.style.display = 'none';
        
        this.elements.authOverlay.style.display = 'flex';
        this.elements.authOverlay.style.opacity = '1';

        // Turn off loading screen
        this.elements.loadingOverlay.style.opacity = '0';
        setTimeout(() => {
          this.elements.loadingOverlay.style.display = 'none';
        }, 300);

        this.render();
      }
    });
  }

  // Switches the auth view panel between "Log In" and "Sign Up" tabs
  switchAuthMode(mode) {
    this.authMode = mode;
    this.elements.authErrorMsg.style.display = 'none';
    this.elements.authErrorMsg.textContent = '';
    
    if (mode === 'login') {
      this.elements.tabLogin.classList.add('active');
      this.elements.tabRegister.classList.remove('active');
      this.elements.authSubmitBtn.textContent = 'Log In';
      this.elements.authPassword.placeholder = '••••••••';
    } else {
      this.elements.tabRegister.classList.add('active');
      this.elements.tabLogin.classList.remove('active');
      this.elements.authSubmitBtn.textContent = 'Sign Up';
      this.elements.authPassword.placeholder = 'At least 6 characters';
    }
  }

  // Handles email submission and signs in or registers via Firebase Authentication
  async handleAuthSubmit(e) {
    e.preventDefault();
    const email = this.elements.authEmail.value.trim();
    const password = this.elements.authPassword.value;

    if (!email || !password) return;

    this.setAuthFormLoading(true);

    try {
      if (this.authMode === 'login') {
        // Signs in an existing account
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        // Registers a new email account
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

  // Triggers the popup window to authorize using a Google account credentials
  async handleGoogleAuth() {
    this.elements.authErrorMsg.style.display = 'none';
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      console.error("Google Auth error:", err);
      // Suppress showing error to user if they closed the popup manually
      if (err.code !== 'auth/popup-closed-by-user') {
        this.showAuthError(err.code || 'unknown', err.message);
      }
    }
  }

  // Signs out the user session
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

  // Disables/enables inputs and changes label styling while performing auth requests
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

  // Translates technical Firebase error codes into friendly warnings for the interface
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
  
  // Triggers store.addTask when submitting the main to-do form
  handleAddTask(e) {
    e.preventDefault();
    const text = this.elements.taskInput.value.trim();
    if (!text) return;

    this.store.addTask(text, this.store.newTaskCategoryId);
    this.elements.taskInput.value = '';
    this.elements.taskInput.focus();
  }

  // Submits the Category Modal form to edit or add a category document
  handleAddCategory(e) {
    e.preventDefault();
    const name = this.elements.categoryNameInput.value.trim();
    if (!name) return;

    if (this.editingCategoryId) {
      // Edit mode
      this.store.updateCategory(this.editingCategoryId, name, this.selectedModalColor);
      this.editingCategoryId = null;
      this.elements.categoryNameInput.value = '';
      this.setModalVisible(false);
    } else {
      // Create mode
      this.store.addCategory(name, this.selectedModalColor);
      this.elements.categoryNameInput.value = '';
      this.setModalVisible(false);
    }
  }

  // Updates the active status filter tab (All, Active, Completed)
  handleStatusFilterChange(status) {
    this.store.selectedStatusFilter = status;
    this.store.save(this.store.STORAGE_KEYS.SELECTED_STATUS, status);
    
    // Toggle active state CSS class
    this.elements.filterAll.classList.toggle('active', status === 'all');
    this.elements.filterActive.classList.toggle('active', status === 'active');
    this.elements.filterCompleted.classList.toggle('active', status === 'completed');

    this.elements.filterAll.setAttribute('aria-selected', status === 'all');
    this.elements.filterActive.setAttribute('aria-selected', status === 'active');
    this.elements.filterCompleted.setAttribute('aria-selected', status === 'completed');

    this.render();
  }

  // Updates the active category filter (All Tasks vs. Specific Category lists)
  handleCategoryFilterChange(catId) {
    this.store.selectedCategoryId = catId;
    this.store.save(this.store.STORAGE_KEYS.SELECTED_CAT, catId);
    
    // Auto-update default input category creator to match
    if (catId !== 'all') {
      this.store.newTaskCategoryId = catId;
    }

    this.elements.sidebar.classList.remove('open'); // Auto-close sidebar on mobile
    this.render();
  }

  // Triggers task toggle mutation
  handleToggleTask(id) {
    this.store.toggleTask(id);
  }

  // Removes a task, running a smooth slide collapse animation before deleting the database path
  handleDeleteTask(id, taskElement) {
    taskElement.classList.add('removing');
    taskElement.addEventListener('animationend', () => {
      this.store.deleteTask(id);
    }, { once: true });
  }

  // Opens the Category Swatch Modal in edit mode, pre-populating fields
  handleEditCategory(catId) {
    const cat = this.store.getCategoryById(catId);
    if (!cat) return;

    this.editingCategoryId = cat.id;
    this.selectedModalColor = cat.color;
    this.elements.categoryNameInput.value = cat.name;
    
    this.elements.categoryModal.querySelector('.modal-title').textContent = 'Edit Category';
    this.elements.categoryModal.querySelector('.modal-submit-btn').textContent = 'Save Changes';

    // Highlight the active swatch color matching this category's color
    this.elements.colorPalette.querySelectorAll('.color-swatch').forEach(swatch => {
      swatch.classList.toggle('active', swatch.dataset.color === cat.color);
    });

    this.setModalVisible(true);
  }

  // Triggers category delete confirmation
  handleDeleteCategory(catId) {
    const defaultCatId = this.store.categories.length > 0 ? this.store.categories[0].id : 'work';
    if (confirm(`Are you sure you want to delete this category? Any tasks inside will be moved to the default category.`)) {
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

  // Controls Category swatch modal visibility and resets form inputs upon dismissal
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

  // ==========================================================================
  // LIGHT/DARK THEME ENGINE
  // ==========================================================================
  
  // Swaps style tokens on the body tag and toggles theme toggle SVG shapes
  applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-theme', isDark);

    const sunIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="theme-icon"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    const moonIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="theme-icon"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

    const activeIcon = isDark ? sunIcon : moonIcon;
    const activeLabel = isDark ? "Switch to light theme" : "Switch to dark theme";

    if (this.elements.themeToggleDesktop) {
      this.elements.themeToggleDesktop.innerHTML = activeIcon;
      this.elements.themeToggleDesktop.setAttribute('aria-label', activeLabel);
    }
    if (this.elements.themeToggleMobile) {
      const mobileIcon = isDark ? sunIcon.replace('width="20" height="20"', 'width="18" height="18"') : moonIcon.replace('width="20" height="20"', 'width="18" height="18"');
      this.elements.themeToggleMobile.innerHTML = mobileIcon;
      this.elements.themeToggleMobile.setAttribute('aria-label', activeLabel);
    }
  }

  // Toggles active application theme mode
  handleThemeToggle() {
    const newTheme = this.store.theme === 'dark' ? 'light' : 'dark';
    this.store.setTheme(newTheme);
    this.applyTheme(newTheme);
  }

  // ==========================================================================
  // RENDERING ENGINE (DOM Builders)
  // ==========================================================================
  
  // Root redraw dispatcher
  render() {
    this.renderSidebarCategories();
    this.renderInputCategorySelector();
    this.renderDashboardStats();
    this.renderTaskList();
  }

  // Redraws the sidebar sections (Views tab and Categories swatches)
  renderSidebarCategories() {
    // 1. Redraw Views container (containing only "All Tasks")
    const viewsList = this.elements.viewsList;
    viewsList.innerHTML = '';

    const allLi = document.createElement('li');
    allLi.className = 'views-item';
    const activeTasksCount = this.store.tasks.filter(t => !t.completed).length;
    const isAllActive = this.store.selectedCategoryId === 'all';
    
    allLi.innerHTML = `
      <button class="category-btn ${isAllActive ? 'active' : ''}" id="cat-all-btn">
        <span class="category-info">
          <svg xmlns="http://www.w3.org/2000/svg" class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
          <span>All Tasks</span>
        </span>
        <span class="category-count">${activeTasksCount}</span>
      </button>
    `;
    allLi.querySelector('button').addEventListener('click', () => this.handleCategoryFilterChange('all'));
    viewsList.appendChild(allLi);

    // 2. Redraw Categories container
    const list = this.elements.categoryList;
    list.innerHTML = '';

    this.store.categories.forEach(cat => {
      const li = document.createElement('li');
      li.className = 'category-item';

      const count = this.store.getActiveCountForCategory(cat.id);
      const isActive = this.store.selectedCategoryId === cat.id;

      li.innerHTML = `
        <div class="category-item-container">
          <button class="category-btn ${isActive ? 'active' : ''}" id="cat-${cat.id}-btn">
            <span class="category-info">
              <span class="category-dot" style="background-color: ${cat.color};"></span>
              <span>${this.escapeHTML(cat.name)}</span>
            </span>
            <span class="category-count">${count}</span>
          </button>
          <div class="category-actions">
            <button class="btn-edit-category" aria-label="Edit category: ${this.escapeHTML(cat.name)}" title="Edit Category">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
            <button class="btn-delete-category" aria-label="Delete category: ${this.escapeHTML(cat.name)}" title="Delete Category">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </div>
      `;

      // Set category clicks
      li.querySelector('.category-btn').addEventListener('click', () => this.handleCategoryFilterChange(cat.id));
      li.querySelector('.btn-edit-category').addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleEditCategory(cat.id);
      });
      li.querySelector('.btn-delete-category').addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleDeleteCategory(cat.id);
      });

      list.appendChild(li);
    });
  }

  // Redraws the category choice dropdown inside the task input bar
  renderInputCategorySelector() {
    const activeCat = this.store.getCategoryById(this.store.newTaskCategoryId);
    if (activeCat) {
      this.elements.taskCategoryBtn.querySelector('.selected-category-dot').style.backgroundColor = activeCat.color;
      this.elements.taskCategoryBtn.querySelector('.selected-category-name').textContent = activeCat.name;
    }

    const dropdown = this.elements.taskCategoryDropdown;
    dropdown.innerHTML = '';

    this.store.categories.forEach(cat => {
      const li = document.createElement('li');
      li.className = 'dropdown-item';
      li.role = 'option';
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
  }

  // Redraws the progress bar fill and updates completion stats (e.g. 1 completed / 3 remaining)
  renderDashboardStats() {
    const stats = this.store.getStats();

    this.elements.progressBarFill.style.width = `${stats.percentage}%`;
    this.elements.progressPercentage.textContent = `${stats.percentage}%`;
    this.elements.progressCompleted.textContent = `${stats.completed} completed`;
    this.elements.progressRemaining.textContent = `${stats.active} remaining`;
    this.elements.activeCountBadge.textContent = stats.active;
  }

  // Redraws the tasks list, grouping them by category headers if viewing "All Tasks"
  renderTaskList() {
    const list = this.elements.tasksList;
    const filteredTasks = this.store.getFilteredTasks();

    list.innerHTML = '';

    // If no tasks match the filter, show the empty placeholder layout
    if (filteredTasks.length === 0) {
      this.elements.emptyState.style.display = 'flex';
      list.style.display = 'none';
      return;
    }

    this.elements.emptyState.style.display = 'none';
    list.style.display = 'flex';

    // Helper: builds individual list item (li) DOM nodes for a task
    const createTaskElement = (task) => {
      const li = document.createElement('li');
      li.className = `task-item ${task.completed ? 'completed' : ''}`;
      li.id = task.id;

      const category = this.store.getCategoryById(task.categoryId) || { name: 'Work', color: '#3B82F6' };
      const completedDateStamp = task.completed && task.completedAt 
        ? `<span class="task-completed-date">Completed on ${this.formatCompletionDate(task.completedAt)}</span>`
        : '';

      li.innerHTML = `
        <div class="task-left">
          <label class="checkbox-container" aria-label="Toggle completed status for ${this.escapeHTML(task.text)}">
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
          <button class="btn-delete-task" aria-label="Delete task: ${this.escapeHTML(task.text)}" title="Delete Task">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
        </div>
      `;

      // Wire DOM events directly on inputs inside list items
      li.querySelector('input[type="checkbox"]').addEventListener('change', () => this.handleToggleTask(task.id));
      li.querySelector('.btn-delete-task').addEventListener('click', () => this.handleDeleteTask(task.id, li));

      return li;
    };

    // Build lists grouped by categories when viewing All Tasks
    if (this.store.selectedCategoryId === 'all') {
      const renderCategoryGroup = (cat) => {
        const catTasks = filteredTasks.filter(t => t.categoryId === cat.id);
        if (catTasks.length > 0) {
          // Render group section subheader
          const header = document.createElement('div');
          header.className = 'task-list-category-header';
          header.innerHTML = `
            <span class="task-list-category-dot" style="background-color: ${cat.color};"></span>
            <span>${this.escapeHTML(cat.name)}</span>
          `;
          list.appendChild(header);

          const pending = catTasks.filter(t => !t.completed);
          const completed = catTasks.filter(t => t.completed);

          // Append uncompleted items
          pending.forEach(task => {
            list.appendChild(createTaskElement(task));
          });

          // Append divider if both pending and completed items exist inside this group
          if (pending.length > 0 && completed.length > 0) {
            const divider = document.createElement('div');
            divider.className = 'category-completed-divider';
            divider.textContent = 'Completed';
            list.appendChild(divider);
          }

          // Append completed items
          completed.forEach(task => {
            list.appendChild(createTaskElement(task));
          });
        }
      };

      // Draw groups one by one
      this.store.categories.forEach(cat => {
        renderCategoryGroup(cat);
      });
    } else {
      // Draw flat task lists when viewing a single category list page
      const pending = filteredTasks.filter(t => !t.completed);
      const completed = filteredTasks.filter(t => t.completed);

      pending.forEach(task => {
        list.appendChild(createTaskElement(task));
      });

      if (pending.length > 0 && completed.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'category-completed-divider';
        divider.textContent = 'Completed';
        list.appendChild(divider);
      }

      completed.forEach(task => {
        list.appendChild(createTaskElement(task));
      });
    }
  }

  // Formats timestamps into reader-friendly dates (e.g. May 27, 2026)
  formatCompletionDate(isoString) {
    if (!isoString) return '';
    try {
      const date = new Date(isoString);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    } catch (e) {
      return '';
    }
  }

  // Prevent Cross-site Scripting (XSS) HTML injection vulnerabilities
  escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// ==========================================================================
// 5. APPLICATION BOOTSTRAP
// ==========================================================================
// Fires when document loads to run TaskStore and AppController instances
document.addEventListener('DOMContentLoaded', () => {
  const store = new TaskStore();
  window.tasklyApp = new AppController(store);
});
