# Smart Classroom Analyzer

Smart Classroom Analyzer is a web-based platform designed to improve classroom management, automate academic workflows, and enhance student engagement through analytics and AI-powered insights.

---

## Project Overview

Traditional classroom management relies on multiple disconnected tools such as manual attendance sheets, email-based assignment submissions, and separate grading systems.

The **Smart Classroom Analyzer** integrates these processes into a single digital platform that enables instructors and students to manage academic activities efficiently.

The system provides tools for attendance tracking, assignment management, performance analytics, real-time collaboration, and AI-driven activity recommendations.

---

## Key Features

- Digital attendance tracking  
- Assignment and activity management  
- Student performance analytics dashboard  
- AI-powered learning activity suggestions  
- Real-time discussion board and live Q&A sessions  
- Student self-service portal  
- Notifications for assignments, grades, and attendance alerts  

---
## System Architecture

The Smart Classroom Analyzer follows a **three-tier architecture** consisting of the Presentation Layer, Application Layer, and Data Layer.

```
        +-----------------------------+
        |         Users               |
        |  Students | Teachers | Admin|
        +-------------+---------------+
                      |
                      |
                (Web Browser)
                      |
                      ▼
        +-----------------------------+
        |        Frontend Layer       |
        |        React.js App         |
        |  - Dashboard                |
        |  - Attendance UI            |
        |  - Assignment Management    |
        |  - Analytics View           |
        +-------------+---------------+
                      |
                      | REST API
                      ▼
        +-----------------------------+
        |        Backend Layer        |
        |      Node.js + Express      |
        |                             |
        |  Modules:                   |
        |  - Authentication           |
        |  - Attendance Service       |
        |  - Assignment Service       |
        |  - Grades & Analytics       |
        |  - Notification Service     |
        |  - AI Recommendation Engine |
        +-------------+---------------+
                      |
                      |
                      ▼
        +-----------------------------+
        |        Data Layer           |
        |        PostgreSQL           |
        |                             |
        |  Tables:                    |
        |  - Users                    |
        |  - Students                 |
        |  - Attendance               |
        |  - Assignments              |
        |  - Grades                   |
        |  - Activities               |
        +-----------------------------+
```

### Architecture Layers

**1. Presentation Layer (Frontend)**  
- Built using **React.js**
- Provides dashboards for students, teachers, and administrators
- Handles user interaction and API communication

**2. Application Layer (Backend)**  
- Built using **Node.js with Express**
- Handles business logic
- Provides REST APIs for the frontend
- Includes modules for attendance, assignments, analytics, and AI recommendations

**3. Data Layer (Database)**  
- Uses **PostgreSQL**
- Stores user data, attendance records, assignments, grades, and activity logs

### Additional Components

- **AI Recommendation Engine**
  - Analyzes student performance
  - Suggests personalized learning activities

- **Notification System**
  - Sends alerts for assignment deadlines
  - Attendance warnings
  - Grade updates
---

## Technologies Used

### Frontend
- React.js  
- HTML5  
- CSS3  
- JavaScript  

### Backend
- Node.js  
- Express.js  

### Database
- PostgreSQL  

### Mobile Application
- Flutter (planned for future implementation)

---

## Project Documentation
- **Statement of Work (SOW)** – Defines project scope, deliverables, and responsibilities  
- **Software Requirements Specification (SRS)** – Describes system requirements, use cases, and architecture  

---


---

## System Modules

### Attendance Management
Allows instructors to record attendance digitally and track student attendance percentages.

### Assignment Management
Instructors can create assignments and students can submit work through the platform.

### Grade and Performance Tracking
Students and instructors can view grades, performance trends, and analytics.

### AI Activity Suggestions
The system analyzes student performance data and recommends personalized learning activities.

### Collaboration Tools
Includes discussion boards and live Q&A sessions for classroom interaction.

---

## Course

Software Engineering  
Mahindra University

---

## Future Improvements

- Mobile application integration  
- Advanced AI-based performance prediction  
- Push notifications and real-time alerts  
- Enhanced analytics dashboards  

---

## License

This project is developed for academic purposes as part of the **Software Engineering course at Mahindra University**.
