# Dolphin overlay plugin (see README.md). Build with build.sh; -DKF=5 or 6
# picks the KDE Frameworks / Qt major version.
cmake_minimum_required(VERSION 3.16)
project(onegy-overlay LANGUAGES CXX)

set(KF 5 CACHE STRING "KDE Frameworks major version: 5 or 6")
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt${KF} REQUIRED COMPONENTS Core Network)
find_package(KF${KF}KIO REQUIRED)

add_library(onegy-overlay MODULE onegy-overlay.cpp)
set_target_properties(onegy-overlay PROPERTIES PREFIX "")
target_compile_definitions(onegy-overlay PRIVATE QT_NO_CAST_FROM_ASCII QT_NO_CAST_TO_ASCII)
target_link_libraries(onegy-overlay PRIVATE Qt${KF}::Core Qt${KF}::Network KF${KF}::KIOCore KF${KF}::KIOWidgets)
